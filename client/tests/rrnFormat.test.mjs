import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRrnInput } from '../src/utils/rrnFormat.ts';

test('formatRrnInput keeps up to 6 leading digits without hyphen', () => {
  assert.equal(formatRrnInput('6511'), '6511');
  assert.equal(formatRrnInput('651128'), '651128');
  assert.equal(formatRrnInput('651128-'), '651128');
});

test('formatRrnInput automatically inserts hyphen on 7th digit when 1, 2, 3, or 4', () => {
  assert.equal(formatRrnInput('6511281'), '651128-1');
  assert.equal(formatRrnInput('6511282'), '651128-2');
  assert.equal(formatRrnInput('0102033'), '010203-3');
  assert.equal(formatRrnInput('0102034'), '010203-4');
  assert.equal(formatRrnInput('651128-1'), '651128-1');
});

test('formatRrnInput rejects 7th digit outside 1-4', () => {
  assert.equal(formatRrnInput('6511280'), '651128');
  assert.equal(formatRrnInput('6511285'), '651128');
  assert.equal(formatRrnInput('6511289'), '651128');
  assert.equal(formatRrnInput('651128-9'), '651128');
});

test('formatRrnInput preserves optional trailing 6 digits or asterisk masking up to 14 chars', () => {
  assert.equal(formatRrnInput('6511281******'), '651128-1******');
  assert.equal(formatRrnInput('651128-1234567'), '651128-1234567');
  assert.equal(formatRrnInput('651128123456789'), '651128-1234567');
});
