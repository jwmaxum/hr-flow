import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import official from '../src/data/withholdingTaxTable2026.json' with { type: 'json' };
import golden from './fixtures/withholding-tax-2026-workbook-golden.json' with { type: 'json' };
import { calculateIncomeTax } from '../src/utils/payroll.ts';

test('all 7,106 public withholding cells and 11 high-income base cells match the audited actual workbook canonical hash', () => {
  const payload = { brackets: official.brackets.map(({ min, max, taxes }) => ({ min, max, taxes })), taxAt10Million: official.taxAt10Million };
  assert.equal(payload.brackets.length, 646);
  assert.equal(payload.brackets.reduce((total, row) => total + row.taxes.length, 0), 7106);
  assert.equal(payload.taxAt10Million.length, 11);
  assert.equal(createHash('sha256').update(JSON.stringify(payload)).digest('hex'), golden.provenance.canonicalSHA256);
  assert.equal(readFileSync(new URL('../src/data/withholdingTaxTable2026.json', import.meta.url)).equals(
    readFileSync(new URL('../../functions/data/withholdingTaxTable2026.json', import.meta.url))), true);
});

for (const dependents of [1, 2, 11, 12, 44, 100]) {
  test(`actual workbook independent golden taxes cover six high-income boundaries ±1 won, children 0~3 and family ${dependents}`, () => {
    const cases = golden.cases.filter(item => item.dependents === dependents);
    assert.equal(cases.length, 72);
    for (const item of cases) {
      // Expected outputs are fixed source-derived integers in the JSON fixture.
      // No formula mirroring the implementation computes the expected amount.
      assert.equal(calculateIncomeTax(item.income, item.dependents, item.children).incomeTax, item.expected,
        `taxable income ${item.income}, family ${item.dependents}, eligible children ${item.children}; ` +
        'source: 근로소득간이세액표!C651:M662; 소득령 별표2!A14:A21');
    }
  });
}

test('actual workbook D227 and D229 child deductions are followed by Income Tax Act 86 small-amount noncollection', () => {
  for (const [income, sourceTax] of [[2260000, 20880], [2280000, 21520]]) {
    const bracket = official.brackets.find(row => row.min * 1000 === income);
    assert.equal(bracket.taxes[1], sourceTax);
    // Source credits: 소득령 별표2!A16 = 20,830. Before statutory
    // noncollection these leave 50 and 690 won; neither is collected.
    assert.equal(calculateIncomeTax(income, 2, 1).incomeTax, 0);
  }
});

test('statutory noncollection uses strictly less than 1000 after child credit and ten-won truncation', () => {
  for (const [beforeTruncation, expected] of [[999, 0], [1000, 1000], [1009, 1000]]) {
    const uploaded = structuredClone(official);
    uploaded.brackets.find(row => row.min === 2280).taxes[1] = 20830 + beforeTruncation;
    assert.equal(calculateIncomeTax(2280000, 2, 1, uploaded).incomeTax, expected,
      `valid complete uploaded table, child-adjusted ${beforeTruncation} won`);
  }
});
