import { Queryable } from './db.service';

/** Job titles of the administrative staff, who get one day of leave a month instead of casual leave. */
export const ADMIN_TITLES = [
  'Admin Assistant', 'Administrative Cum Accounts Coordinator', 'EA to MD & CEO', 'Receptionist',
  'Office Assistant', 'Driver', 'Housekeeping', 'Administrative Staff',
];

interface Row {
  code: string; name: string; days: number; accrual: 'upfront' | 'monthly' | 'event'; carryMax: number; half: boolean;
  types: string[]; sort: number;
  carryMode?: 'cap' | 'rolling'; validMonths?: number; only?: string[] | null; except?: string[] | null; gender?: 'female' | 'male' | null;
  advance?: number; lop?: boolean; maxTimes?: number | null; minService?: number | null; calendar?: boolean; doc?: number | null;
}

const BOTH = ['permanent', 'contract'];

export const POLICY: Row[] = [
  // 1.25 days a month from April; last year's balance is used first and lapses on 30 June.
  { code: 'CL', name: 'Casual Leave', days: 15, accrual: 'monthly', carryMax: 15, half: true, types: BOTH, sort: 1,
    carryMode: 'rolling', validMonths: 3, except: ADMIN_TITLES, advance: 2, lop: true },
  // 1 day a month for administrative staff; carried forward, lapses at the end of the year (31 March).
  { code: 'AL', name: 'Leave (Administrative staff)', days: 12, accrual: 'monthly', carryMax: 12, half: true, types: BOTH, sort: 2,
    carryMode: 'rolling', validMonths: 0, only: ADMIN_TITLES, advance: 2, lop: true },
  // Maternity and Paternity Policy: 12 weeks fully paid, 4 weeks for a miscarriage, 15 days paternity.
  { code: 'ML', name: 'Maternity Leave', days: 84, accrual: 'event', carryMax: 0, half: false, types: BOTH, sort: 5,
    gender: 'female', maxTimes: 2, minService: 80, calendar: true, doc: 0 },
  { code: 'MSC', name: 'Miscarriage Leave', days: 28, accrual: 'event', carryMax: 0, half: false, types: BOTH, sort: 6,
    gender: 'female', calendar: true, doc: 0 },
  { code: 'PL', name: 'Paternity Leave', days: 15, accrual: 'event', carryMax: 0, half: false, types: BOTH, sort: 7,
    gender: 'male', maxTimes: 2, minService: 365, calendar: true, doc: 0 },
];

/**
 * Loads the StartupTN leave policy. Safe to run again. Leave years become April to March, and the
 * credits the portal had worked out under the old rules are cleared so it works them out again
 * (leave already taken and manual adjustments are never touched).
 */
export async function applyLeavePolicy(q: Queryable, opts: { force?: boolean } = {}) {
  const taken = (await q.query(
    `select count(*) as n from leave_ledger where entry_type in ('debit','reversal','adjustment')`)).rows[0].n;
  const current = (await q.query(`select value from org_settings where key = 'leave_year_start_month'`)).rows[0]?.value;
  if (Number(taken) > 0 && Number(current) !== 4 && !opts.force) {
    throw new Error(`Leave has already been taken or adjusted under calendar-year leave years (${taken} entries). ` +
      'Changing to April-March would shift those entries into the wrong year. Run with --force only if you have checked them.');
  }
  await q.query(
    `insert into org_settings (key, value) values ('leave_year_start_month', '4') on conflict (key) do update set value = '4'`);
  await q.query(`delete from leave_ledger where entry_type in ('opening','accrual','carry_forward','lapse')`);

  for (const r of POLICY) {
    await q.query(
      `insert into leave_types (code, name, annual_entitlement, accrual, carry_forward_max, allow_half_day, paid,
                                applicable_employment_types, requires_document_after_days, active, sort_order,
                                carry_mode, carry_valid_months, only_designations, except_designations, only_gender,
                                max_times, min_service_days, count_calendar_days, advance_days, lop_when_exhausted)
       values ($1,$2,$3,$4,$5,$6,true,$7,$8,true,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       on conflict (code) do update set
         name = excluded.name, annual_entitlement = excluded.annual_entitlement, accrual = excluded.accrual,
         carry_forward_max = excluded.carry_forward_max, allow_half_day = excluded.allow_half_day,
         applicable_employment_types = excluded.applicable_employment_types,
         requires_document_after_days = excluded.requires_document_after_days, active = true, sort_order = excluded.sort_order,
         carry_mode = excluded.carry_mode, carry_valid_months = excluded.carry_valid_months,
         only_designations = excluded.only_designations, except_designations = excluded.except_designations,
         only_gender = excluded.only_gender, max_times = excluded.max_times, min_service_days = excluded.min_service_days,
         count_calendar_days = excluded.count_calendar_days,
         advance_days = excluded.advance_days, lop_when_exhausted = excluded.lop_when_exhausted`,
      [r.code, r.name, r.days, r.accrual, r.carryMax, r.half, r.types, r.doc ?? null, r.sort,
       r.carryMode ?? 'cap', r.validMonths ?? 0, r.only ?? null, r.except ?? null, r.gender ?? null,
       r.maxTimes ?? null, r.minService ?? null, r.calendar ?? false, r.advance ?? 0, r.lop ?? false]);
  }

  // Earned, sick and loss-of-pay leave are not used: loss of pay is worked out automatically on casual leave.
  await q.query(`update leave_types set active = false where code in ('EL','SL','LOP')`);
}
