const { fail } = require('./security-context');

const VERSIONS = 'erpLedgerVersions';
const scope = Symbol('ERP request ledger');
const writer = new Set(['create', 'set', 'update', 'delete']);
const stale = () => fail('aborted', '사용 중인 ERP 장부가 전환되었습니다. 새로 조회한 후 다시 진행해 주세요.');

function activeVersion(company) {
  const id = company?.erpActiveLedgerVersion;
  if (id === undefined || id === '') return '';
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    fail('failed-precondition', '회사 ERP 장부 버전을 확인해 주세요.');
  }
  return id;
}

function writeRevision(company) {
  const revision = company?.erpLedgerWriteRevision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) {
    fail('failed-precondition', '회사 ERP 장부 변경 번호를 확인해 주세요.');
  }
  return revision;
}

function ledgerParent(companyRef, version) {
  return version ? companyRef.collection(VERSIONS).doc(activeVersion({ erpActiveLedgerVersion: version }))
    .collection('ledger').doc(companyRef.id) : companyRef;
}

function method(target, key) {
  const value = target[key];
  return typeof value === 'function' ? value.bind(target) : value;
}

// Operational handlers historically obtain both company metadata and ledger
// collections from the same company reference. Keep metadata at its real path;
// give child queries native Firestore references for the pinned generation.
function routeDatabase(db, user) {
  const version = activeVersion(user.company);
  const tenant = user.companyId;
  if (db[scope]) {
    if (db[scope].version !== version || db[scope].tenant !== tenant) stale();
    return db;
  }
  const companyCollection = db.collection('companies');
  const company = companyCollection.doc(tenant);
  const ledger = ledgerParent(company, version);
  function check(snapshot) {
    if (!snapshot.exists || activeVersion(snapshot.data()) !== version) stale();
    return snapshot;
  }
  const facade = new Proxy(company, { get(target, key) {
    if (key === 'path') return ledger.path;
    if (key === 'get') return async () => check(await company.get());
    if (key === 'collection') return name => ledger.collection(name);
    return method(target, key);
  } });
  const companies = new Proxy(companyCollection, { get(target, key) {
    if (key === 'doc') return id => id === tenant ? facade : target.doc(id);
    return method(target, key);
  } });

  // ERP control/approval, draft creation, document issuance and postings all
  // use runTransaction. Increment once per committing transaction, including
  // audit-only writes. The read of the company serializes with the cutover.
  function runTransaction(callback, options) {
    return db.runTransaction(async tx => {
      const snapshot = check(await tx.get(company));
      let changed = false;
      const transaction = new Proxy(tx, { get(target, key) {
        if (key === 'get') return ref => ref === facade ? Promise.resolve(snapshot) : target.get(ref);
        if (writer.has(key)) return (...args) => {
          changed = true;
          target[key](...args);
          return transaction;
        };
        return method(target, key);
      } });
      const result = await callback(transaction);
      if (changed) tx.update(company, { erpLedgerWriteRevision: writeRevision(snapshot.data()) + 1 });
      return result;
    }, options);
  }
  return new Proxy(db, { get(target, key) {
    if (key === scope) return { tenant, version };
    if (key === 'collection') return path => path === 'companies' ? companies : target.collection(path);
    if (key === 'doc') return path => {
      if (path === company.path) return facade;
      // Absolute ERP document lookups are used by invoice issuance. References
      // assembled from ledger.path already carry the correct physical root.
      if (version && path.startsWith(company.path + '/erp') && !path.startsWith(company.path + '/' + VERSIONS + '/')) {
        return target.doc(ledger.path + path.slice(company.path.length));
      }
      return target.doc(path);
    };
    if (key === 'runTransaction') return runTransaction;
    return method(target, key);
  } });
}

module.exports = { activeVersion, writeRevision, ledgerParent, routeDatabase };
