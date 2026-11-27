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
