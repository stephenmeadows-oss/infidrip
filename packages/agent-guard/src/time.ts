/**
 * RFC 3339 timestamps as integer milliseconds since the Unix epoch.
 * The evaluator uses this instead of Date.parse so checks do not depend on the host clock
 * or on implementation-defined parsing of extra fractional digits.
 * Accepted years are 1970 through 9999. Fractional seconds are truncated to milliseconds.
 */

const TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

export function parseTimeMs(value: string): number | null {
  if (typeof value !== "string") return null;
  const match = TIME_RE.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7];
  const offsetBody = match[8];
  const offsetSign = match[9];
  const offsetHour = match[10];
  const offsetMinute = match[11];

  if (year < 1970 || year > 9999) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  const millis = fraction ? Number(fraction.slice(0, 3).padEnd(3, "0")) : 0;
  let offsetMinutes = 0;
  if (offsetBody !== "Z") {
    const oh = Number(offsetHour);
    const om = Number(offsetMinute);
    if (oh > 23 || om > 59) return null;
    offsetMinutes = (offsetSign === "-" ? -1 : 1) * (oh * 60 + om);
  }

  const days = daysFromCivil(year, month, day);
  const localMs = days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1_000 + millis;
  return localMs - offsetMinutes * 60_000;
}

export function isInRollingWindow(atMs: number, nowMs: number, periodSeconds: number): boolean {
  const age = nowMs - atMs;
  return age >= 0 && age < periodSeconds * 1000;
}

function daysInMonth(year: number, month: number): number {
  const lengths = [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return lengths[month - 1] ?? 0;
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Days since 1970-01-01. Howard Hinnant's civil-from-days inverse, for positive years. */
function daysFromCivil(year: number, month: number, day: number): number {
  let y = year;
  if (month <= 2) y -= 1;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const monthPart = month + (month > 2 ? -3 : 9);
  const doy = Math.floor((153 * monthPart + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
