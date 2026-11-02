/**
 * Reads the list of punches the biometric machine's server returns (the `strDataList` of eSSL
 * eTimeTracklite's GetTransactionsLog, or a file HR exports from the same software).
 *
 * The vendor's manual does not show what that list looks like, so this reads the shapes such software
 * commonly produces rather than assuming one: comma, semicolon, tab, pipe or space separated lines (with
 * or without a header), JSON, and XML rows. A row it cannot make sense of is counted and reported, never
 * guessed at, and the caller refuses the whole batch when most rows are unreadable.
 *
 * Times on the machine are India time with no zone.
 */

export interface ParsedPunch {
  /** The person's code on the machine. */
  code: string;
  at: Date;
  serial: string | null;
  /** What the machine called the punch ("in", "out"), if it says. Not used to pair punches. */
  direction: string | null;
}

export interface ParseResult {
  punches: ParsedPunch[];
  /** Rows that could not be read. */
  rejected: number;
  /** The first few unreadable rows, for the person fixing the export. */
  samples: string[];
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const TIME = String.raw`(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*([AaPp][Mm])?`;
const ISO_DT = new RegExp(String.raw`^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T]+${TIME}$`);
const DMY_DT = new RegExp(String.raw`^(\d{1,2})[-/](\d{1,2})[-/](\d{4})[ T]+${TIME}$`);
const DMON_DT = new RegExp(String.raw`^(\d{1,2})[- ]([A-Za-z]{3})[A-Za-z]*[- ](\d{4})[ T]+${TIME}$`);
const WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
const DATE_ONLY = /^(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4}|\d{1,2}[- ][A-Za-z]{3}[A-Za-z]*[- ]\d{4})$/;
const TIME_ONLY = new RegExp(`^${TIME}$`);
const DIRECTION = /^(in|out|check[-_ ]?in|check[-_ ]?out|entry|exit)$/i;
const SERIAL_LIKE = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9]{8,}$/;
const CODE_LIKE = /^[A-Za-z0-9_.\-/]{1,40}$/;

function build(y: number, mo: number, d: number, h: number, mi: number, s: number, meridiem?: string): Date | null {
  if (meridiem) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (/p/i.test(meridiem) ? 12 : 0);
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1) return null; // 31 February and the like
  const pad = (n: number) => String(n).padStart(2, '0');
  const t = Date.parse(`${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}+05:30`);
  return Number.isNaN(t) ? null : new Date(t);
}

/** A date and time as machines write them; null when the text is not one. */
export function parseDateTime(text: string): Date | null {
  const t = text.trim();
  if (WITH_ZONE.test(t)) {
    const ms = Date.parse(t);
    return Number.isNaN(ms) ? null : new Date(ms);
  }
  let m = ISO_DT.exec(t);
  if (m) return build(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0), m[7]);
  m = DMY_DT.exec(t);
  if (m) return build(+m[3], +m[2], +m[1], +m[4], +m[5], +(m[6] ?? 0), m[7]);
  m = DMON_DT.exec(t);
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    return month ? build(+m[3], month, +m[1], +m[4], +m[5], +(m[6] ?? 0), m[7]) : null;
  }
  return null;
}

const decodeEntities = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const clean = (s: string) => s.trim().replace(/^["'\[]+|["'\]]+$/g, '').trim();

// ---------------------------------------------------------------------------- records (JSON, XML, headers)

const CODE_KEYS = ['employeecode', 'empcode', 'employeeid', 'empid', 'userid', 'code', 'enrollno', 'enrollmentno', 'badge', 'badgenumber', 'pin', 'cardno'];
const DATETIME_KEYS = ['logdatetime', 'logdate', 'punchdatetime', 'punchtime', 'datetime', 'timestamp', 'checktime', 'transactiontime', 'transactiondate', 'attendancedate', 'date'];
const TIME_KEYS = ['logtime', 'time', 'punchtimeonly'];
const SERIAL_KEYS = ['serialnumber', 'deviceserial', 'deviceserialnumber', 'sn', 'devicesn', 'deviceid'];
const DIRECTION_KEYS = ['direction', 'punchdirection', 'inout', 'inoutmode', 'punchstate', 'attendancestatus', 'status', 'type'];

function fromRecord(rec: Record<string, unknown>, fallbackSerial: string | null): ParsedPunch | null {
  const norm: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) if (v !== null && v !== undefined && typeof v !== 'object') norm[squash(k)] = String(v).trim();
  const pick = (keys: string[]) => keys.map((k) => norm[k]).find((v) => v !== undefined && v !== '');

  const code = pick(CODE_KEYS);
  if (!code || !CODE_LIKE.test(code)) return null;
  let at: Date | null = null;
  for (const k of DATETIME_KEYS) {
    const v = norm[k];
    if (!v) continue;
    at = parseDateTime(v);
    if (!at && DATE_ONLY.test(v)) {
      const time = pick(TIME_KEYS);
      if (time) at = parseDateTime(`${v} ${time}`);
    }
    if (at) break;
  }
  if (!at) return null;
  const dir = pick(DIRECTION_KEYS);
  return { code, at, serial: pick(SERIAL_KEYS) ?? fallbackSerial, direction: dir && DIRECTION.test(dir) ? dir.toLowerCase() : null };
}

function recordsFromJson(text: string): Record<string, unknown>[] | null {
  try {
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : Object.values(data as object).find(Array.isArray);
    return Array.isArray(list) ? list.filter((r) => r && typeof r === 'object') : null;
  } catch {
    return null;
  }
}

/** Rows of an XML document: any element made up only of simple child elements (`<Row><Code>1</Code>…</Row>`). */
function recordsFromXml(text: string): Record<string, unknown>[] {
  const row = /<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>((?:\s*<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>[^<]*<\/\3>\s*)+)<\/\1>/g;
  const field = /<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>([^<]*)<\/\1>/g;
  const out: Record<string, unknown>[] = [];
  for (const r of text.matchAll(row)) {
    const rec: Record<string, unknown> = {};
    for (const f of r[2].matchAll(field)) rec[f[1]] = decodeEntities(f[2]);
    out.push(rec);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ lines

function splitLine(line: string): string[] {
  const sep = /[,;\t|]/.test(line) ? /[,;\t|]/ : /\s+/;
  const tokens = line.split(sep).map(clean).filter((t) => t !== '');
  // "2021-05-22", "09:10:11" arrive as two cells when the machine writes date and time apart
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (DATE_ONLY.test(tokens[i]) && i + 1 < tokens.length && TIME_ONLY.test(tokens[i + 1])) {
      out.push(`${tokens[i]} ${tokens[i + 1]}`);
      i++;
    } else {
      out.push(tokens[i]);
    }
  }
  return out;
}

function fromTokens(tokens: string[], serials: string[], fallbackSerial: string | null): ParsedPunch | null {
  const at = tokens.map(parseDateTime).find((d) => d !== null) ?? null;
  if (!at) return null;
  const rest = tokens.filter((t) => parseDateTime(t) === null);
  const serial = rest.find((t) => serials.includes(t)) ?? rest.find((t) => SERIAL_LIKE.test(t) && /[A-Za-z]{2}/.test(t)) ?? null;
  const direction = rest.find((t) => DIRECTION.test(t)) ?? null;
  const code = rest.find((t) => t !== serial && t !== direction && CODE_LIKE.test(t));
  if (!code) return null;
  return { code, at, serial: serial ?? fallbackSerial, direction: direction ? direction.toLowerCase() : null };
}

const looksLikeHeader = (tokens: string[]) =>
  tokens.length >= 2 && tokens.every((t) => !parseDateTime(t)) && tokens.some((t) => /code|emp|user|id/i.test(t)) && tokens.some((t) => /date|time/i.test(t));

// ------------------------------------------------------------------------------------------------- entry

export function parseBiometricLog(raw: string, opts: { serials?: string[]; serial?: string | null } = {}): ParseResult {
  const serials = opts.serials ?? [];
  const fallbackSerial = opts.serial ?? null;
  const result: ParseResult = { punches: [], rejected: 0, samples: [] };
  const reject = (what: string) => {
    result.rejected++;
    if (result.samples.length < 5) result.samples.push(what.slice(0, 160));
  };

  let text = raw.replace(/^﻿/, '').trim();
  if (!text) return result;
  if (/&lt;|&gt;/.test(text) && !/^[<\[{]/.test(text)) text = decodeEntities(text);
  if (/&lt;/.test(text)) text = decodeEntities(text);

  const records = text.startsWith('<') ? recordsFromXml(text) : /^[\[{]/.test(text) ? recordsFromJson(text) : null;
  if (records) {
    for (const rec of records) {
      const p = fromRecord(rec, fallbackSerial);
      if (p) result.punches.push(p);
      else reject(JSON.stringify(rec));
    }
    return result;
  }

  let lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 1 && (lines[0].match(/\d{1,2}:\d{2}/g) ?? []).length > 1) lines = lines[0].split(';').map((l) => l.trim()).filter(Boolean);

  let header: string[] | null = null;
  for (const line of lines) {
    const tokens = splitLine(line);
    if (!header && result.punches.length === 0 && looksLikeHeader(tokens)) {
      header = tokens;
      continue;
    }
    let punch: ParsedPunch | null = null;
    if (header && tokens.length >= header.length) {
      punch = fromRecord(Object.fromEntries(header.map((h, i) => [h, tokens[i]])), fallbackSerial);
    }
    punch ??= fromTokens(tokens, serials, fallbackSerial);
    if (punch) result.punches.push(punch);
    else reject(line);
  }
  return result;
}
