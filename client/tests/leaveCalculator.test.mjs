import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateLeaveEntitlement, calculateTotalLeave, isValidJoinDateString } from '../src/utils/leaveCalculator.ts';

test('isValidJoinDateString validates calendar YYYY-MM-DD dates strictly', () => {
  assert.equal(isValidJoinDateString('2024-02-29'), true); // leap year
  assert.equal(isValidJoinDateString('2025-02-29'), false); // non-leap year
  assert.equal(isValidJoinDateString('2026-11-26'), true);
  assert.equal(isValidJoinDateString('2026-13-01'), false);
  assert.equal(isValidJoinDateString(''), false);
  assert.equal(isValidJoinDateString('invalid'), false);
});

test('calculateLeaveEntitlement follows Korean Labor Standards Act accurately', () => {
  const today = new Date(2026, 10, 26); // 2026-11-26

  // 미등록 또는 미래 입사일은 음수 없이 0일
  assert.equal(calculateLeaveEntitlement('', today), 0);
  assert.equal(calculateLeaveEntitlement(null, today), 0);
  assert.equal(calculateLeaveEntitlement('2026-12-15', today), 0);
  assert.equal(calculateLeaveEntitlement('2026-11-26', today), 0);

  // 1년 미만: 1개월 개근 시 1일, 최대 11일
  assert.equal(calculateLeaveEntitlement('2026-10-26', today), 1);
  assert.equal(calculateLeaveEntitlement('2026-06-26', today), 5);
  assert.equal(calculateLeaveEntitlement('2025-12-01', today), 11);

  // 1년 이상: 기본 15일 + 2년마다 1일 가산, 최대 25일
  assert.equal(calculateLeaveEntitlement('2025-11-26', today), 15); // 만 1년
  assert.equal(calculateLeaveEntitlement('2024-11-26', today), 15); // 만 2년
  assert.equal(calculateLeaveEntitlement('2023-11-26', today), 16); // 만 3년
  assert.equal(calculateLeaveEntitlement('2021-11-26', today), 17); // 만 5년
  assert.equal(calculateLeaveEntitlement('2000-01-01', today), 25); // 25일 상한
});

test('calculateTotalLeave adds additionalLeave safely to joinDate entitlement', () => {
  const today = new Date(2026, 10, 26);
  assert.equal(calculateTotalLeave('2025-11-26', 2, today), 17);
  assert.equal(calculateTotalLeave('2025-11-26', 0.5, today), 15.5);
  assert.equal(calculateTotalLeave('', 3, today), 3);
  assert.equal(calculateTotalLeave('2026-12-01', 0, today), 0);
});
