import { countLeaveDays, leaveMonths, leaveYearBounds, monthlyAccrual, prorateUpfront } from '../src/leave/leave-calc';
import { addDays, dayOfWeek, istDate, istInstant, istMinutes, leaveYearOf, monthRange } from '../src/common/dates';

describe('countLeaveDays', () => {
  const weekend = [0, 6];

  it('skips weekends inside the range', () => {
    // Mon 2 Nov 2026 .. Mon 9 Nov 2026 = 6 working days (Mon-Fri + Mon)
    const r = countLeaveDays({ from: '2026-11-02', to: '2026-11-09', dayPart: 'full', holidays: new Set(), weeklyOffDays: weekend });
    expect(r.days).toBe(6);
  });

  it('skips holidays too', () => {
    const r = countLeaveDays({ from: '2027-01-25', to: '2027-01-27', dayPart: 'full', holidays: new Set(['2027-01-26']), weeklyOffDays: weekend });
    expect(r.days).toBe(2);
    expect(r.workingDates).toEqual(['2027-01-25', '2027-01-27']);
  });

  it('counts a half day as 0.5, but only on a working day', () => {
    const ok = countLeaveDays({ from: '2026-11-03', to: '2026-11-03', dayPart: 'first_half', holidays: new Set(), weeklyOffDays: weekend });
    expect(ok.days).toBe(0.5);
    const sunday = countLeaveDays({ from: '2026-11-01', to: '2026-11-01', dayPart: 'second_half', holidays: new Set(), weeklyOffDays: weekend });
    expect(sunday.days).toBe(0);
  });

  it('a range made only of non-working days counts zero', () => {
    const r = countLeaveDays({ from: '2026-10-31', to: '2026-11-01', dayPart: 'full', holidays: new Set(), weeklyOffDays: weekend });
    expect(r.days).toBe(0);
  });

  it('honours a different weekly-off pattern', () => {
    const r = countLeaveDays({ from: '2026-11-02', to: '2026-11-08', dayPart: 'full', holidays: new Set(), weeklyOffDays: [0] });
    expect(r.days).toBe(6); // Mon-Sat
  });
});

describe('leave year arithmetic', () => {
  it('calendar year and April-March year', () => {
    expect(leaveYearBounds(2027, 1)).toEqual(['2027-01-01', '2027-12-31']);
    expect(leaveYearBounds(2026, 4)).toEqual(['2026-04-01', '2027-03-31']);
    expect(leaveMonths(2026, 4)).toEqual(['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03']);
  });

  it('assigns a date to its leave year', () => {
    expect(leaveYearOf('2027-02-10', 1)).toBe(2027);
    expect(leaveYearOf('2027-02-10', 4)).toBe(2026);
    expect(leaveYearOf('2026-04-01', 4)).toBe(2026);
    expect(leaveYearOf('2026-03-31', 4)).toBe(2025);
  });
});

describe('entitlement rules', () => {
  it('gives the full entitlement to someone who joined before the year or in its first month', () => {
    expect(prorateUpfront(12, '2024-02-12', 2027, 1)).toBe(12);
    expect(prorateUpfront(12, '2027-01-18', 2027, 1)).toBe(12);
    expect(prorateUpfront(12, null, 2027, 1)).toBe(12);
  });

  it('prorates a mid-year joiner to the nearest half day', () => {
    expect(prorateUpfront(12, '2027-07-01', 2027, 1)).toBe(6); // 6 months left
    expect(prorateUpfront(12, '2027-11-10', 2027, 1)).toBe(2); // Nov + Dec
    expect(prorateUpfront(15, '2027-05-03', 2027, 1)).toBe(10); // 8/12 of 15
    expect(prorateUpfront(10, '2027-03-15', 2027, 1)).toBe(8.5); // 10/12*10 = 8.33 -> 8.5
  });

  it('prorates against an April-March year', () => {
    expect(prorateUpfront(12, '2026-10-05', 2026, 4)).toBe(6); // Oct..Mar = 6 months
  });

  it('monthly accrual sums to exactly the annual entitlement', () => {
    for (const ent of [12, 15, 10, 7, 21]) {
      let sum = 0;
      for (let k = 1; k <= 12; k++) sum += monthlyAccrual(ent, k);
      expect(Math.round(sum * 100) / 100).toBe(ent);
    }
    expect(monthlyAccrual(15, 1)).toBe(1.25);
  });
});

describe('Asia/Kolkata date helpers', () => {
  it('turns an instant into the India calendar date', () => {
    // 20:00 UTC on 31 Oct is already 1:30 AM on 1 Nov in India
    expect(istDate(new Date('2026-10-31T20:00:00Z'))).toBe('2026-11-01');
    expect(istDate(new Date('2026-11-01T18:29:00Z'))).toBe('2026-11-01');
    expect(istDate(new Date('2026-11-01T18:30:00Z'))).toBe('2026-11-02');
  });

  it('computes minutes since midnight and round-trips a local time', () => {
    expect(istMinutes(new Date('2026-11-02T04:00:00Z'))).toBe(9 * 60 + 30);
    expect(istInstant('2026-11-02', '09:30').toISOString()).toBe('2026-11-02T04:00:00.000Z');
  });

  it('date arithmetic', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(dayOfWeek('2026-11-02')).toBe(1);
    expect(monthRange('2028-02')).toEqual(['2028-02-01', '2028-02-29']);
  });
});
