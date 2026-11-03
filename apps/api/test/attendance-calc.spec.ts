import {
  DayInput, Fence, PunchEvent, deriveDayStatus, haversineMeters, isImpossibleTravel, matchGeofence, pairSessions, summarise,
} from '../src/attendance/attendance-calc';
import { istInstant } from '../src/common/dates';

const MON = '2026-11-02';
const rules = { work_start: '09:30', grace_minutes: 15, full_day_minutes: 480, half_day_minutes: 240 };

const at = (hhmm: string, date = MON) => istInstant(date, hhmm);
const inn = (hhmm: string, flags: string[] = [], date = MON): PunchEvent => ({ type: 'check_in', at: at(hhmm, date), flags });
const out = (hhmm: string, flags: string[] = [], date = MON): PunchEvent => ({ type: 'check_out', at: at(hhmm, date), flags });

const day = (over: Partial<DayInput> = {}): DayInput => ({
  date: MON, today: '2026-11-10', employed: true, holiday: false, weeklyOff: false, leaveFull: false, leaveHalf: false,
  od: false, permissions: [], events: [], rules, ...over,
});

describe('geography', () => {
  it('measures distances on the ground', () => {
    expect(haversineMeters(13.0827, 80.2707, 13.0827, 80.2707)).toBe(0);
    // about 100 m north
    expect(haversineMeters(13.0827, 80.2707, 13.0836, 80.2707)).toBeCloseTo(100, -1);
    // Chennai to Bengaluru, roughly 290 km as the crow flies
    expect(haversineMeters(13.0827, 80.2707, 12.9716, 77.5946) / 1000).toBeGreaterThan(280);
    expect(haversineMeters(13.0827, 80.2707, 12.9716, 77.5946) / 1000).toBeLessThan(300);
  });

  const office: Fence = { id: 'office', name: 'Head office', latitude: 13.0827, longitude: 80.2707, radiusM: 150 };
  const annex: Fence = { id: 'annex', name: 'Annex', latitude: 13.0900, longitude: 80.2707, radiusM: 100 };

  it('says whether a point is inside the nearest fence', () => {
    expect(matchGeofence(13.0830, 80.2707, [office, annex])).toMatchObject({ fenceId: 'office', within: true, distanceM: 33 });
    const outside = matchGeofence(13.0860, 80.2707, [office]);
    expect(outside).toMatchObject({ fenceId: 'office', within: false });
    expect(outside.distanceM).toBeGreaterThan(300);
  });

  it('matches the nearest fence when outside all, and the deepest when inside several', () => {
    expect(matchGeofence(13.0895, 80.2707, [office, annex])).toMatchObject({ fenceId: 'annex', within: true });
    const big: Fence = { ...office, id: 'campus', radiusM: 5000 };
    expect(matchGeofence(13.0827, 80.2707, [big, office]).fenceId).toBe('office'); // dead centre of the small one
    expect(matchGeofence(13.2, 80.4, [office, annex])).toMatchObject({ within: false });
  });

  it('reports nothing to compare with when no fence is set up', () => {
    expect(matchGeofence(13, 80, [])).toEqual({ fenceId: null, fenceName: null, distanceM: null, within: null });
  });

  it('spots travel that cannot be real', () => {
    expect(isImpossibleTravel(200_000, 30 * 60_000)).toBe(true);   // 200 km in half an hour
    expect(isImpossibleTravel(20_000, 30 * 60_000)).toBe(false);   // 40 km/h
    expect(isImpossibleTravel(500, 1000)).toBe(false);             // too short to judge
    expect(isImpossibleTravel(5_000, 0)).toBe(true);               // 5 km in no time at all
  });
});

describe('pairing punches', () => {
  it('adds up closed sessions', () => {
    const s = pairSessions([inn('09:00'), out('13:00'), inn('14:00'), out('18:00')]);
    expect(s).toMatchObject({ minutes: 480, openSince: null, firstIn: at('09:00'), lastOut: at('18:00') });
  });

  it('works whatever order the events arrive in', () => {
    expect(pairSessions([out('18:00'), inn('09:00')]).minutes).toBe(540);
  });

  it('ignores a repeated check-in and a check-out with nothing open', () => {
    expect(pairSessions([out('08:00'), inn('09:00'), inn('09:30'), out('17:00')])).toMatchObject({ minutes: 480, firstIn: at('09:00') });
  });

  it('leaves an unfinished session open and uncounted', () => {
    expect(pairSessions([inn('09:00'), out('12:00'), inn('13:00')])).toMatchObject({ minutes: 180, openSince: at('13:00') });
  });

  it('skips events replaced by a correction', () => {
    const s = pairSessions([inn('09:40', ['superseded']), out('13:00', ['superseded']), inn('09:30', ['regularised']), out('18:00', ['regularised'])]);
    expect(s.minutes).toBe(510);
  });
});

describe('deriveDayStatus — an ordinary working day', () => {
  it('present for a full day, on time', () => {
    expect(deriveDayStatus(day({ events: [inn('09:20'), out('18:00')] }))).toMatchObject({ status: 'present', late: false, workedMinutes: 520 });
  });

  it('exactly the required hours is enough; a minute short is a half day', () => {
    expect(deriveDayStatus(day({ events: [inn('09:00'), out('17:00')] }))!.status).toBe('present');
    expect(deriveDayStatus(day({ events: [inn('09:00'), out('16:59')] }))!.status).toBe('half_day');
  });

  it('half day from four hours, absent below that', () => {
    expect(deriveDayStatus(day({ events: [inn('09:00'), out('13:00')] }))!.status).toBe('half_day');
    const short = deriveDayStatus(day({ events: [inn('09:00'), out('12:59')] }))!;
    expect(short.status).toBe('absent');
    expect(short.flags).toContain('short_hours');
  });

  it('adds up several sessions', () => {
    expect(deriveDayStatus(day({ events: [inn('09:00'), out('13:00'), inn('14:00'), out('18:00')] }))!.status).toBe('present');
  });

  it('late only after work start plus grace', () => {
    expect(deriveDayStatus(day({ events: [inn('09:45'), out('18:00')] }))!.late).toBe(false);
    expect(deriveDayStatus(day({ events: [inn('09:46'), out('18:00')] }))!.late).toBe(true);
  });

  it('an approved morning permission excuses a late arrival; an afternoon one does not', () => {
    const events = [inn('10:15'), out('18:30')];
    expect(deriveDayStatus(day({ events, permissions: [{ from: '09:30', to: '10:30' }] }))!.late).toBe(false);
    expect(deriveDayStatus(day({ events, permissions: [{ from: '14:00', to: '15:00' }] }))!.late).toBe(true);
  });

  it('permission time counts towards the working hours', () => {
    const events = [inn('09:30'), out('16:30')]; // 7 hours
    expect(deriveDayStatus(day({ events }))!.status).toBe('half_day');
    expect(deriveDayStatus(day({ events, permissions: [{ from: '16:30', to: '17:30' }] }))!.status).toBe('present');
  });

  it('no punches: absent in the past, nothing yet today or ahead', () => {
    expect(deriveDayStatus(day())!.status).toBe('absent');
    expect(deriveDayStatus(day({ date: '2026-11-10' }))).toBeNull();
    expect(deriveDayStatus(day({ date: '2026-11-11' }))).toBeNull();
  });

  it('a check-in with no check-out is in progress today and a problem afterwards', () => {
    expect(deriveDayStatus(day({ date: '2026-11-10', events: [inn('09:30', [], '2026-11-10')] }))).toMatchObject({ status: 'incomplete', flags: [] });
    const old = deriveDayStatus(day({ events: [inn('09:30')] }))!;
    expect(old.status).toBe('incomplete');
    expect(old.flags).toContain('missing_checkout');
  });

  it('carries location flags from the punches, ignoring replaced ones', () => {
    const r = deriveDayStatus(day({
      events: [inn('09:00', ['outside_geofence', 'low_accuracy']), out('17:30', ['impossible_travel']), inn('08:00', ['superseded', 'gone'])],
    }))!;
    expect(r.flags).toEqual(['impossible_travel', 'low_accuracy', 'outside_geofence']);
  });
});

describe('deriveDayStatus — days that are not ordinary', () => {
  it('holidays and weekly offs, even when someone works', () => {
    expect(deriveDayStatus(day({ holiday: true }))!.status).toBe('holiday');
    expect(deriveDayStatus(day({ weeklyOff: true }))!.status).toBe('weekly_off');
    const worked = deriveDayStatus(day({ holiday: true, events: [inn('10:00'), out('14:00')] }))!;
    expect(worked).toMatchObject({ status: 'holiday', workedMinutes: 240 });
    expect(worked.flags).toContain('worked_on_off_day');
  });

  it('approved leave and on-duty days, in the past and the future', () => {
    expect(deriveDayStatus(day({ leaveFull: true }))!.status).toBe('leave');
    expect(deriveDayStatus(day({ leaveFull: true, date: '2026-12-01' }))!.status).toBe('leave');
    expect(deriveDayStatus(day({ od: true, date: '2026-12-01' }))!.status).toBe('od');
    expect(deriveDayStatus(day({ leaveFull: true, events: [inn('10:00'), out('11:00')] }))!.flags).toContain('worked_on_leave');
  });

  it('leave or duty spanning a day off leaves that day a day off', () => {
    expect(deriveDayStatus(day({ leaveFull: true, weeklyOff: true }))!.status).toBe('weekly_off');
    expect(deriveDayStatus(day({ od: true, holiday: true }))!.status).toBe('holiday');
  });

  it('half-day leave: only the other half must be worked', () => {
    const ok = deriveDayStatus(day({ leaveHalf: true, events: [inn('09:30'), out('13:30')] }))!;
    expect(ok).toMatchObject({ status: 'half_day', late: false });
    expect(ok.flags).toEqual(['half_day_leave']);

    expect(deriveDayStatus(day({ leaveHalf: true, events: [inn('09:30'), out('11:30')] }))!.flags).toEqual(['half_day_leave', 'short_hours']);
    expect(deriveDayStatus(day({ leaveHalf: true }))!.flags).toEqual(['half_day_leave', 'no_attendance']);
    expect(deriveDayStatus(day({ leaveHalf: true, date: '2026-12-01' }))).toMatchObject({ status: 'half_day', flags: ['half_day_leave'] });
    // arriving after the grace period is not "late" when the morning is on leave
    expect(deriveDayStatus(day({ leaveHalf: true, events: [inn('13:00'), out('17:00')] }))!.late).toBe(false);
  });

  it('shows nothing outside the person\'s employment', () => {
    expect(deriveDayStatus(day({ employed: false, events: [inn('09:00'), out('18:00')] }))).toBeNull();
  });
});

describe('summarise', () => {
  it('counts each kind of day', () => {
    const s = summarise([
      { status: 'present', late: true, workedMinutes: 500 }, { status: 'present', late: false, workedMinutes: 480 },
      { status: 'half_day', late: false, workedMinutes: 250 }, { status: 'absent', late: false, workedMinutes: 0 },
      { status: 'leave', late: false, workedMinutes: 0 }, { status: 'od', late: false, workedMinutes: 0 },
      { status: 'holiday', late: false, workedMinutes: 0 }, { status: 'weekly_off', late: false, workedMinutes: 0 },
      { status: 'incomplete', late: false, workedMinutes: 0, flags: ['missing_checkout'] },
      { status: 'incomplete', late: false, workedMinutes: 0 }, { status: null, late: false, workedMinutes: 0 },
    ]);
    expect(s).toEqual({ present: 2, halfDay: 1, absent: 1, leave: 1, od: 1, holidays: 1, weeklyOffs: 1, incomplete: 2, missingCheckout: 1, late: 1, workedMinutes: 1230 });
  });
});
