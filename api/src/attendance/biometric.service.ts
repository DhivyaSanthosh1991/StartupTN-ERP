import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/auth.types';
import { DayRecalc } from '../common/day-recalc.service';
import { addDays, eachDate, istDate, istInstant, todayIst } from '../common/dates';
import { badRequest } from '../common/errors';
import { AppConfig, CONFIG } from '../config/config';
import { Db, Queryable } from '../db/db.service';
import { BiometricApiError, fetchTransactionsLog } from './biometric-api';
import { parseBiometricLog } from './biometric-parse';

/** Two punches closer than this are one visit to the machine, not an arrival and a departure. */
export const MIN_SPAN_MINUTES = 5;
/** The machine's server is asked for at most this many days at a time. */
const WINDOW_DAYS = 7;
const MAX_REBUILD_DAYS = 93;
/** A punch dated further ahead than this means the machine's clock is wrong. */
const MAX_FUTURE_MS = 36 * 3_600_000;

export interface ImportSummary {
  runId: string;
  rowsRead: number;
  inserted: number;
  duplicates: number;
  unmatched: number;
  rejected: number;
  /** Attendance days worked out again because of this import. */
  daysUpdated: number;
}

export interface SyncSummary {
  configured: boolean;
  devices: number;
  inserted: number;
  failed: number;
  messages: string[];
}

/**
 * Attendance for people on the biometric machine at head office. The machine's punches are kept exactly as
 * received; each person's day is then worked out from them: the first punch is the check-in and the last
 * is the check-out (breaks in between are not deducted). A day HR has corrected by hand is left alone.
 */
@Injectable()
export class BiometricService {
  private readonly log = new Logger(BiometricService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly recalc: DayRecalc,
  ) {}

  get configured(): boolean {
    return !!this.config.biometricApiUrl;
  }

  // ------------------------------------------------------------------------------------------- import

  /** Reads a punch list (an uploaded file, or the machine server's answer) and brings attendance up to date. */
  async importText(
    actor: AuthUser | null,
    text: string,
    opts: { source: 'file' | 'api'; serial?: string | null; rangeFrom?: string; rangeTo?: string },
    now: Date = new Date(),
  ): Promise<ImportSummary> {
    const run = (await this.db.one<{ id: string }>(
      `insert into biometric_imports (source, range_from, range_to, device_serial, actor_id) values ($1,$2,$3,$4,$5) returning id`,
      [opts.source, opts.rangeFrom ?? null, opts.rangeTo ?? null, opts.serial ?? null, actor?.id ?? null]))!;
    const fail = async (message: string, counts: Partial<ImportSummary> = {}) => {
      await this.db.query(
        `update biometric_imports set status = 'failed', finished_at = now(), message = $2, rows_read = $3, rejected = $4 where id = $1`,
        [run.id, message.slice(0, 500), counts.rowsRead ?? 0, counts.rejected ?? 0]);
      throw badRequest('BIOMETRIC_IMPORT_FAILED', message);
    };

    const parsed = parseBiometricLog(text, { serials: this.config.biometricDeviceSerials, serial: opts.serial ?? null });
    const punches = parsed.punches.filter((p) => p.at.getTime() <= now.getTime() + MAX_FUTURE_MS);
    const tooNew = parsed.punches.length - punches.length;
    const rejected = parsed.rejected + tooNew;
    const rowsRead = punches.length + rejected;
    if (rowsRead > 0 && (punches.length === 0 || rejected / rowsRead > 0.5)) {
      const example = parsed.samples[0] ? ` The first row it could not read: "${parsed.samples[0]}".` : '';
      return fail(`Most rows could not be read (${rejected} of ${rowsRead}), so nothing was imported.${example}`, { rowsRead, rejected });
    }

    const codes = [...new Set(punches.map((p) => p.code))];
    const people = new Map(
      (await this.db.rows<{ id: string; biometric_code: string }>('select id, biometric_code from employees where biometric_code = any($1::text[])', [codes]))
        .map((e) => [e.biometric_code, e.id]));

    let inserted = 0;
    let unmatched = 0;
    for (let i = 0; i < punches.length; i += 500) {
      const part = punches.slice(i, i + 500);
      const res = await this.db.query(
        `insert into biometric_punches (device_serial, biometric_code, punched_at, direction, employee_id)
         select u.serial, u.code, u.at, u.dir, e.id
           from unnest($1::text[], $2::text[], $3::timestamptz[], $4::text[]) as u(serial, code, at, dir)
           left join employees e on e.biometric_code = u.code
         on conflict (device_serial, biometric_code, punched_at) do nothing
         returning employee_id`,
        [part.map((p) => p.serial ?? opts.serial ?? 'file'), part.map((p) => p.code), part.map((p) => p.at), part.map((p) => p.direction)]);
      inserted += res.rowCount ?? 0;
      unmatched += res.rows.filter((r) => r.employee_id === null).length;
    }

    // Days to work out again: those in this import, plus any earlier punches that now have an owner.
    const affected = new Map<string, Set<string>>();
    const touch = (employeeId: string, date: string) => affected.set(employeeId, (affected.get(employeeId) ?? new Set()).add(date));
    for (const p of punches) {
      const id = people.get(p.code);
      if (id) touch(id, istDate(p.at));
    }
    for (const [id, dates] of await this.linkUnmatched()) for (const d of dates) touch(id, d);
    const daysUpdated = await this.deriveAll(affected);

    const summary: ImportSummary = { runId: run.id, rowsRead, inserted, duplicates: punches.length - inserted, unmatched, rejected, daysUpdated };
    const quiet = opts.source === 'api' && inserted === 0 && rejected === 0;
    if (quiet) {
      await this.db.query('delete from biometric_imports where id = $1', [run.id]); // a pull that found nothing new is not worth a row
    } else {
      await this.db.query(
        `update biometric_imports set status = 'done', finished_at = now(), rows_read = $2, inserted = $3, duplicates = $4, unmatched = $5, rejected = $6,
                message = $7 where id = $1`,
        [run.id, rowsRead, inserted, summary.duplicates, unmatched, rejected,
         parsed.samples.length ? `Some rows could not be read, for example: "${parsed.samples[0]}"` : null]);
    }
    if (actor) {
      await this.audit.record({ actorId: actor.id, action: 'biometric.import', entityType: 'attendance', after: { source: opts.source, ...summary } });
    }
    return summary;
  }

  // -------------------------------------------------------------------------------------------- sync

  /** Pulls the latest punches from every configured machine. Safe to run as often as wanted. */
  async sync(actor: AuthUser | null, now: Date = new Date()): Promise<SyncSummary> {
    const out: SyncSummary = { configured: this.configured, devices: 0, inserted: 0, failed: 0, messages: [] };
    if (!this.configured) return out;
    const to = todayIst(now);
    const from = addDays(to, -this.config.biometricLookbackDays);

    for (const serial of this.config.biometricDeviceSerials) {
      out.devices++;
      try {
        for (let a = from; a <= to; a = addDays(a, WINDOW_DAYS)) {
          const b = addDays(a, WINDOW_DAYS - 1) < to ? addDays(a, WINDOW_DAYS - 1) : to;
          const text = await fetchTransactionsLog(this.config, serial, a, b);
          out.inserted += (await this.importText(actor, text, { source: 'api', serial, rangeFrom: a, rangeTo: b }, now)).inserted;
        }
        await this.db.query(
          `insert into biometric_devices (device_serial, last_checked_at, last_ok_at, last_error) values ($1, now(), now(), null)
           on conflict (device_serial) do update set last_checked_at = now(), last_ok_at = now(), last_error = null`, [serial]);
      } catch (err) {
        out.failed++;
        const message = err instanceof BiometricApiError ? err.message : err instanceof Error ? (err as any).response?.message ?? err.message : String(err);
        out.messages.push(`${serial}: ${message}`);
        this.log.warn(`Biometric sync of ${serial} failed: ${message}`);
        await this.db.query(
          `insert into biometric_devices (device_serial, last_checked_at, last_error) values ($1, now(), $2)
           on conflict (device_serial) do update set last_checked_at = now(), last_error = $2`, [serial, message.slice(0, 300)]);
      }
    }
    return out;
  }

  // ----------------------------------------------------------------------------------------- derive

  /** Gives earlier punches an owner once HR has entered that code on someone. Returns the days that changed. */
  private async linkUnmatched(): Promise<Map<string, Set<string>>> {
    const linked = new Map<string, Set<string>>();
    for (const r of (await this.db.query(
      `update biometric_punches p set employee_id = e.id from employees e
        where p.employee_id is null and p.biometric_code = e.biometric_code returning p.employee_id, p.punched_at`)).rows) {
      linked.set(r.employee_id, (linked.get(r.employee_id) ?? new Set()).add(istDate(r.punched_at)));
    }
    return linked;
  }

  /** Works out each listed person's days from their stored punches. Returns how many days were looked at. */
  private async deriveAll(affected: Map<string, Set<string>>): Promise<number> {
    let days = 0;
    for (const [employeeId, dates] of affected) {
      const sorted = [...dates].sort();
      await this.db.tx(async (q) => {
        await q.query('select pg_advisory_xact_lock(hashtext($1))', [`punch:${employeeId}`]);
        const method = (await q.query('select attendance_method from employees where id = $1', [employeeId])).rows[0]?.attendance_method;
        if (method !== 'biometric') return; // their punches are kept, but the portal's selfie is their record
        for (const date of sorted) await this.deriveDay(q, employeeId, date);
        await this.recalc.run(q, employeeId, sorted[0], sorted[sorted.length - 1]);
        days += sorted.length;
      });
    }
    return days;
  }

  private async deriveDay(q: Queryable, employeeId: string, date: string) {
    // An approved correction is the final word on that day.
    const corrected = (await q.query(
      `select 1 from attendance_events where employee_id = $1 and work_date = $2 and source = 'regularisation' limit 1`, [employeeId, date])).rows.length > 0;
    if (corrected) return;

    await q.query(`delete from attendance_events where employee_id = $1 and work_date = $2 and source = 'biometric'`, [employeeId, date]);
    const start = istInstant(date, '00:00');
    const punches = (await q.query(
      `select punched_at from biometric_punches where employee_id = $1 and punched_at >= $2 and punched_at < $3 order by punched_at`,
      [employeeId, start, new Date(start.getTime() + 86_400_000)])).rows.map((r) => r.punched_at as Date);
    if (!punches.length) return;

    const insert = (type: 'check_in' | 'check_out', at: Date) =>
      q.query(
        `insert into attendance_events (employee_id, event_type, event_at, work_date, flags, source) values ($1,$2,$3,$4,'{}','biometric')`,
        [employeeId, type, at, date]);
    await insert('check_in', punches[0]);
    const last = punches[punches.length - 1];
    if (last.getTime() - punches[0].getTime() >= MIN_SPAN_MINUTES * 60_000) await insert('check_out', last);
  }

  /**
   * Works the days in a range out again from the stored punches: after HR changes someone's code or method,
   * or after fixing a mapping. People no longer on the machine lose their machine-made events in that range.
   */
  async rebuild(actor: AuthUser, from: string, to: string): Promise<{ people: number; days: number }> {
    if (eachDate(from, to).length > MAX_REBUILD_DAYS) throw badRequest('RANGE_TOO_LONG', `Choose at most ${MAX_REBUILD_DAYS} days at a time`);
    const dates = eachDate(from, to);
    const start = istInstant(from, '00:00');
    const end = new Date(istInstant(to, '00:00').getTime() + 86_400_000);
    await this.linkUnmatched();
    const ids = (await this.db.rows<{ employee_id: string }>(
      `select employee_id from biometric_punches where employee_id is not null and punched_at >= $1 and punched_at < $2
       union select employee_id from attendance_events where source = 'biometric' and work_date between $3 and $4`, [start, end, from, to])).map((r) => r.employee_id);

    for (const id of ids) {
      await this.db.tx(async (q) => {
        await q.query('select pg_advisory_xact_lock(hashtext($1))', [`punch:${id}`]);
        const method = (await q.query('select attendance_method from employees where id = $1', [id])).rows[0]?.attendance_method;
        for (const date of dates) {
          if (method === 'biometric') await this.deriveDay(q, id, date);
          else await q.query(`delete from attendance_events where employee_id = $1 and work_date = $2 and source = 'biometric'`, [id, date]);
        }
        await this.recalc.run(q, id, from, to);
      });
    }
    await this.audit.record({ actorId: actor.id, action: 'biometric.rebuild', entityType: 'attendance', after: { from, to, people: ids.length } });
    return { people: ids.length, days: ids.length * dates.length };
  }

  // ------------------------------------------------------------------------------------------ status

  async status() {
    const devices = await this.db.rows<{ device_serial: string; last_checked_at: Date | null; last_ok_at: Date | null; last_error: string | null }>(
      'select * from biometric_devices');
    const known = new Map(devices.map((d) => [d.device_serial, d]));
    const runs = await this.db.rows(
      `select i.id, i.source, i.started_at, i.finished_at, i.range_from::text as range_from, i.range_to::text as range_to, i.device_serial,
              i.rows_read, i.inserted, i.duplicates, i.unmatched, i.rejected, i.status, i.message, a.full_name as actor_name
         from biometric_imports i left join employees a on a.id = i.actor_id order by i.started_at desc limit 10`);
    const unmatched = await this.db.rows(
      `select biometric_code as code, count(*)::int as punches, max(punched_at) as last_at
         from biometric_punches where employee_id is null group by biometric_code order by count(*) desc, max(punched_at) desc limit 20`);
    const methods = await this.db.rows<{ attendance_method: string; n: number }>(
      `select attendance_method, count(*)::int as n from employees where status = 'active' group by attendance_method`);
    return {
      configured: this.configured,
      server: this.configured ? new URL(this.config.biometricApiUrl).host : null,
      lookbackDays: this.config.biometricLookbackDays,
      devices: this.config.biometricDeviceSerials.map((serial) => ({
        serial, lastCheckedAt: known.get(serial)?.last_checked_at ?? null, lastOkAt: known.get(serial)?.last_ok_at ?? null, lastError: known.get(serial)?.last_error ?? null,
      })),
      people: { biometric: methods.find((m) => m.attendance_method === 'biometric')?.n ?? 0, selfie: methods.find((m) => m.attendance_method === 'selfie')?.n ?? 0 },
      runs: runs.map((r) => ({
        id: r.id as string, source: r.source as 'file' | 'api', startedAt: r.started_at as Date, status: r.status as string, device: r.device_serial as string | null,
        from: r.range_from as string | null, to: r.range_to as string | null, rowsRead: r.rows_read as number, inserted: r.inserted as number,
        duplicates: r.duplicates as number, unmatched: r.unmatched as number, rejected: r.rejected as number, message: r.message as string | null, by: r.actor_name as string | null,
      })),
      unmatched: unmatched.map((u) => ({ code: u.code as string, punches: u.punches as number, lastAt: u.last_at as Date })),
    };
  }
}
