/**
 * Formats Korean Resident Registration Number (RRN) input for HR records.
 * - Accepts 6 birth-date digits, automatically inserts '-' before the 7th digit.
 * - Restricts the 7th digit (century/gender code) to '1' | '2' | '3' | '4'.
 * - Allows optional remaining 6 digits or '*' masking (max 14 chars: YYMMDD-G******).
 */
export function formatRrnInput(raw: string): string {
  const cleaned = raw.replace(/[^0-9*]/g, '');
  const front = cleaned.replace(/\*/g, '').slice(0, 6);
  if (front.length < 6) return front;

  // Locate characters after the first 6 numeric digits in cleaned input.
  let seenDigits = 0;
  let splitIndex = 0;
  for (let i = 0; i < cleaned.length; i += 1) {
    if (/[0-9]/.test(cleaned[i])) {
      seenDigits += 1;
      if (seenDigits === 6) {
        splitIndex = i + 1;
        break;
      }
    }
  }
  const rest = cleaned.slice(splitIndex);
  if (!rest) return front;

  const seventh = rest[0];
  if (!/[1-4]/.test(seventh)) return front;

  const tail = rest.slice(1, 7);
  return `${front}-${seventh}${tail}`;
}
