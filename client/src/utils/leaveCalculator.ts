import { differenceInYears, differenceInMonths } from 'date-fns';

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * YYYY-MM-DD 문자열이 실제 존재하는 유효한 달력 날짜인지 검증합니다.
 */
export const isValidJoinDateString = (value: string): boolean => {
  const match = DATE_ONLY_PATTERN.exec(value.trim());
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
};

/**
 * 입사일(Date 또는 YYYY-MM-DD 문자열)을 타임존 오차 없는 로컬 자정 Date로 변환합니다.
 */
export const parseJoinDate = (value: Date | string | null | undefined): Date | null => {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (isValidJoinDateString(trimmed)) {
    const [year, month, day] = trimmed.split('-').map(Number);
    return new Date(year, month - 1, day);
  }
  const fallback = new Date(trimmed);
  return Number.isFinite(fallback.getTime()) ? fallback : null;
};

/**
 * 입사일을 기준으로 법정 기본 발생 연차를 계산합니다. (한국 근로기준법 제60조)
 * 1년 미만: 1개월 개근 시 1일 산정 (0 ~ 최대 11일)
 * 1년 이상: 기본 15일 + 2년마다 1일 가산 (최대 25일)
 * 입사일이 없거나 미래 날짜인 경우 0일을 반환합니다.
 *
 * @param joinDate - 임직원의 입사일 (Date 또는 YYYY-MM-DD 문자열)
 * @param currentDate - 기준일 (기본값: 오늘)
 * @returns - 법정 기본 발생 연차 일수 (number)
 */
export const calculateLeaveEntitlement = (
  joinDate: Date | string | null | undefined,
  currentDate: Date = new Date()
): number => {
  const parsed = parseJoinDate(joinDate);
  if (!parsed || !Number.isFinite(currentDate.getTime())) return 0;

  const years = differenceInYears(currentDate, parsed);
  const months = differenceInMonths(currentDate, parsed);

  if (months <= 0) return 0;

  if (years < 1) {
    // 1년 미만: 1개월 1일 발생, 최대 11일
    return Math.max(0, Math.min(months, 11));
  }

  // 1년 이상: 기본 15일 + (근속연수 - 1)/2 마다 가산 (소수점 버림)
  const additionalDays = Math.floor((years - 1) / 2);
  const totalDays = 15 + additionalDays;

  // 근로기준법상 최대 한도는 25일
  return Math.min(totalDays, 25);
};

/**
 * 입사일 기준 법정 기본 연차와 관리자 부여 추가 연차를 합산한 총 발생 연차를 계산합니다.
 */
export const calculateTotalLeave = (
  joinDate: Date | string | null | undefined,
  additionalLeave = 0,
  currentDate: Date = new Date()
): number => {
  const base = calculateLeaveEntitlement(joinDate, currentDate);
  const extra = Number.isFinite(additionalLeave) ? additionalLeave : 0;
  return Math.max(0, base + extra);
};
