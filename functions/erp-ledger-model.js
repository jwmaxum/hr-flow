const { fail } = require('./security-context');
const { decimal, round, safe } = require('./erp-import-schema');
const { erpMaster: master } = require('./erp-service');
const TRANSFER_KEYS = ['transferInQuantityScaled','transferInValue','transferOutQuantityScaled','transferOutValue'];
const EFFECT_KEYS = ['openingQuantityScaled','openingValue','inQuantityScaled','inValue','outQuantityScaled','outValue','adjustQuantityScaled','adjustValue','salesKRW','cogsKRW', ...TRANSFER_KEYS];
// Firestore can reorder map keys between preview and commit.
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => master.hash(JSON.stringify(canonical(value)));
const zeroEffect = () => Object.fromEntries(EFFECT_KEYS.map(key => [key, 0]));
function signed(value, label = '원장 금액') {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 9e12) fail('failed-precondition', `${label}의 정밀도·허용 범위를 확인해 주세요.`);
  return value;
}
function exactObject(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) fail('invalid-argument', '허용된 요청 항목만 입력해 주세요.');
  return value;
}
function text(value, label, max = 500, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > max || /\p{Cc}/u.test(value) || required && !value.trim()) fail('invalid-argument', `${label}을(를) 확인해 주세요.`);
  return value.trim().normalize('NFC');
}
function date(value) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) fail('invalid-argument', '2000~2099년의 날짜를 입력해 주세요.');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== value) fail('invalid-argument', '실제 날짜를 입력해 주세요.');
  return value;
}
function effectOf(row) {
  if (row.effect) return Object.fromEntries(EFFECT_KEYS.map(key => [key, signed(row.effect[key] === undefined && TRANSFER_KEYS.includes(key) ? 0 : row.effect[key])]));
  const result = zeroEffect();
  if (!Number.isSafeInteger(row.quantityScaled) || row.quantityScaled < 0) fail('failed-precondition', '원장 수량을 확인해 주세요.');
  if (row.type === 'OPENING') { result.openingQuantityScaled = row.quantityScaled; result.openingValue = row.value; }
  else if (row.type === 'MOVEMENTS' && row.direction === '입고') { result.inQuantityScaled = row.quantityScaled; result.inValue = row.value; }
  else if (row.type === 'MOVEMENTS' && row.direction === '출고') {
    result.outQuantityScaled = row.quantityScaled; result.outValue = row.cost; result.salesKRW = row.value; result.cogsKRW = row.cost;
  } else fail('failed-precondition', '지원하지 않는 원장 형식입니다.');
  for (const key of EFFECT_KEYS) signed(result[key]);
  return result;
}
const quantityDelta = effect => signed(effect.openingQuantityScaled + effect.inQuantityScaled - effect.outQuantityScaled + effect.adjustQuantityScaled + (effect.transferInQuantityScaled || 0) - (effect.transferOutQuantityScaled || 0), '원장 수량');
const valueDelta = effect => signed(effect.openingValue + effect.inValue - effect.outValue + effect.adjustValue + (effect.transferInValue || 0) - (effect.transferOutValue || 0));
const reverse = effect => Object.fromEntries(EFFECT_KEYS.map(key => [key, -effect[key]]));
const compare = (a,b) => a.date.localeCompare(b.date) || a.order - b.order || a.rowNo - b.rowNo || a.id.localeCompare(b.id);
function allocation(total, before, amount, original) {
  if (!Number.isSafeInteger(total) || total < 0 || !original || before + amount > original) fail('failed-precondition', '원거래 반품 금액을 확인해 주세요.');
  return safe(round(BigInt(total) * BigInt(before + amount), BigInt(original)) - round(BigInt(total) * BigInt(before), BigInt(original)));
}
function averageCost(value, quantity, out) {
  if (!out || out > quantity) fail('failed-precondition', '현재 재고보다 많은 수량을 차감할 수 없습니다.');
  return out === quantity ? value : safe(round(BigInt(value) * BigInt(out), BigInt(quantity)));
}
function applyEffect(balance, effect) {
  const quantityScaled = signed(balance.quantityScaled + quantityDelta(effect), '재고수량'), value = signed(balance.value + valueDelta(effect));
  if (quantityScaled < 0 || value < 0 || !quantityScaled && value !== 0) fail('failed-precondition', '반영 후 재고수량·금액이 음수이거나 수량 0에 금액이 남습니다. 거래 순서와 조정 금액을 확인해 주세요.');
  return { quantityScaled, value };
}
module.exports = { EFFECT_KEYS, zeroEffect, effectOf, quantityDelta, valueDelta, reverse, compare, allocation, averageCost, applyEffect, signed, hash, exactObject, text, date, decimal };
