import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const file = new URL('../src/components/ErpBootstrapConfirmation.tsx', import.meta.url);
const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
}).outputText;
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports, require: createRequire(import.meta.url) });
const { ErpBootstrapConfirmation, ErpBootstrapBackupResult } = mod.exports;
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));

test('first-import, blocked existing-ledger and legacy previews display distinct consent controls', () => {
  const form = protection => render(ErpBootstrapConfirmation, {
    job: { protection }, companyName: '검증 회사', busy: false, dirty: false
  });
  assert.match(form({ hasExistingData: false }), /최초 이관 확인/);
  const blocked = form({ hasExistingData: true, existingDocumentCount: 25 });
  assert.match(blocked, /erp-bootstrap-warning/);
  assert.match(blocked, /문서 25건이 있어 일반 재이관이 차단/);
  assert.match(blocked, /type="checkbox"/);
  assert.doesNotMatch(blocked, /type="password"/);
  const legacy = form(undefined);
  assert.match(legacy, /장부 보호 상태를 확인할 수 없어/);
  assert.match(legacy, /type="submit"[^>]*disabled/);
  assert.doesNotMatch(legacy, /type="checkbox"/);
});

test('verified copy shows the durable backup ID and all six reconciliation categories', () => {
  const checks = Object.fromEntries(['inventory','receivables','bundles','pendingCosts','monthCloses','approvals']
    .map(key => [key, { count: 2, digest: 'test' }]));
  const html = render(ErpBootstrapBackupResult, { backup: {
    id: 'backup-example', reconciliation: { verified: true, documentCount: 12, checks }
  } });
  assert.match(html, /backup-example/);
  assert.match(html, /12건/);
  for (const label of ['재고','미수잔액','세트 구성','원가 미확정 수량','월마감 관련 기록','승인·감사 기록']) {
    assert.ok(html.includes(label+' · 2건 일치'), label);
  }
});

test('governance settings and audit records do not increase the count of close or approval documents', () => {
  const checks = Object.fromEntries(['inventory','receivables','bundles','pendingCosts','monthCloses','approvals']
    .map(key => [key, { count: key === 'monthCloses' ? 1 : key === 'approvals' ? 61 : 0, digest: 'test' }]));
  const html = render(ErpBootstrapBackupResult, { backup: {
    id: 'copy', counts: { erpGovernance: 1, erpAudit: 61, erpMonthCloses: 0, erpApprovals: 0 },
    reconciliation: { verified: true, documentCount: 62, checks }
  } });
  assert.match(html, /월마감 관련 기록 · 1건 일치 \(마감 보관 문서 0건\)/);
  assert.match(html, /승인·감사 기록 · 61건 일치 \(승인 요청 문서 0건\)/);
});

test('a staged mismatch asks for a separate warning and confirmation even for an empty company', () => {
  const props={ job:{protection:{hasExistingData:false},stage:{status:'MISMATCH'},stageConflict:{challenge:'retry'}},
    companyName:'샘플',busy:false,dirty:false};
  const html=render(ErpBootstrapConfirmation,props);
  assert.match(html,/업로드 자료로 새 장부 재작성 경고/);
  assert.match(html,/erp-bootstrap-warning/);
  assert.match(html,/ADMIN 재인증 후 새 장부 재작성/);
  assert.match(html,/type="submit"[^>]*disabled/);
});

test('comparison preserves foreign currency precision and changes between old and imported amounts', () => {
  const metrics={inventoryQuantity:1,inventoryValue:100,bundleCount:0,pendingQuantity:0,monthCloseCount:0,approvalCount:0};
  const html=render(mod.exports.ErpLedgerComparisonTable,{comparison:{
    previous:{...metrics,receivableTotals:[{currency:'USD',amountMinor:1250}]},
    incoming:{...metrics,receivableTotals:[{currency:'USD',amountMinor:1005}]}
  }});
  assert.match(html,/12.5 USD/);assert.match(html,/10.05 USD/);assert.match(html,/-2.45 USD/);
});

test('reopening an approved first-import repair asks for a fresh password to switch', () => {
  const html = render(ErpBootstrapConfirmation, {
    job: {protection:{hasExistingData:false,repairChallengeIssuedAt:'2026-11-27T00:00:00Z'}},
    companyName:'샘플',busy:false,dirty:false
  });
  assert.match(html,/재작성한 장부 전환 확인/);
  assert.match(html,/ADMIN 인증 후 검증된 장부 전환/);
});
