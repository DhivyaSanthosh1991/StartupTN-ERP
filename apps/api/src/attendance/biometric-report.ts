import type { ParsedPunch, ParseResult } from './biometric-parse';

/**
 * Reads the "Monthly Status Report" that eSSL eTimeTracklite exports to Excel (saved as CSV text).
 * It is laid out per person: an "Employee:" line ("002 : Name"), then rows Status, InTime, OutTime, Duration
 * and so on, with one column per day under a "Days" header ("1 S", "2 M", ...). The report keeps only the first
 * and last punch of each day, so each day gives up to two punches: the in-time and the out-time.
 *
 * Several sheets (one per company) may follow each other; each has its own date line and day header.
 * A cell that is not a time, or an out-time earlier than the in-time, is counted and reported, not guessed at.
 */

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const RANGE = /([A-Za-z]{3})[A-Za-z]*\s+(\d{1,2})\s+(\d{4})\s+to\s+/i;
const CLOCK = /^(\d{1,2}):(\d{2})$/;

export const isStatusReport = (text: string) => /monthly\s+status\s+report/i.test(text) && /(^|\n)[\s",]*employee\s*:/i.test(text);

/** One line of CSV into cells, honouring quotes. */
export function csvCells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');
const label = (cells: string[]) => cells.find((c) => c !== '')?.replace(/:$/, '').trim().toLowerCase() ?? '';

export function parseStatusReport(text: string, serial: string | null): ParseResult {
  const result: ParseResult = { punches: [], rejected: 0, samples: [] };
  const reject = (what: string) => {
    result.rejected++;
    if (result.samples.length < 5) result.samples.push(what.slice(0, 160));
  };

  let start: { y: number; m: number } | null = null;
  let dates: (string | null)[] = []; // the date of each column, from the "Days" header
  let code: string | null = null;
  let inTimes: (string | null)[] = [];

  const emit = (date: string, hhmm: string, direction: 'in' | 'out') => {
    const [h, m] = hhmm.split(':').map(Number);
    if (h > 23 || m > 59) return reject(`${code} ${date} ${hhmm}`);
    const at = new Date(`${date}T${pad(h)}:${pad(m)}:00+05:30`);
    result.punches.push({ code: code!, at, serial, direction });
  };

  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const cells = csvCells(raw);
    const first = label(cells);

    const range = cells.map((c) => RANGE.exec(c)).find(Boolean);
    if (range) {
      const m = MONTHS[range[1].toLowerCase()];
      start = m ? { y: Number(range[3]), m } : null;
      continue;
    }

    if (first === 'days') {
      dates = [];
      if (!start) reject('The date line (for example "Nov 01 2026 To Nov 11 2026") was not found above the days');
      let { y, m } = start ?? { y: 0, m: 0 };
      let prev = 0;
      cells.forEach((c, i) => {
        const d = /^(\d{1,2})\b/.exec(c);
        if (i === 0 || !d || !start) return void dates.push(null);
        const day = Number(d[1]);
        if (day < prev) { m++; if (m > 12) { m = 1; y++; } } // the report runs into the next month
        prev = day;
        dates[i] = `${y}-${pad(m)}-${pad(day)}`;
      });
      continue;
    }

    if (first === 'employee') {
      const cell = cells.slice(1).find((c) => c.includes(':')) ?? '';
      const m = /^\s*(\S+)\s*:/.exec(cell);
      code = m ? m[1] : null;
      inTimes = [];
      continue;
    }

    if (first === 'intime' || first === 'outtime') {
      const isIn = first === 'intime';
      if (!code || !dates.length) { cells.slice(1).filter(Boolean).forEach((c) => reject(c)); continue; }
      if (isIn) inTimes = [];
      cells.forEach((c, i) => {
        if (i === 0 || c === '' || !dates[i]) return;
        if (!CLOCK.test(c)) return reject(`${code} ${dates[i]} "${c}"`);
        if (isIn) { inTimes[i] = c; return; }
        const inn = inTimes[i];
        if (inn && minutes(c) < minutes(inn)) { reject(`${code} ${dates[i]} out ${c} is before in ${inn}`); return; }
        emit(dates[i]!, c, 'out');
      });
      if (isIn) cells.forEach((c, i) => { if (i > 0 && dates[i] && CLOCK.test(c)) emit(dates[i]!, c, 'in'); });
    }
  }
  // People in the order they appear, each person's punches in time order.
  const order = new Map<string, number>();
  for (const p of result.punches) if (!order.has(p.code)) order.set(p.code, order.size);
  result.punches.sort((x, y) => order.get(x.code)! - order.get(y.code)! || x.at.getTime() - y.at.getTime());
  return result;
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export type { ParsedPunch };
