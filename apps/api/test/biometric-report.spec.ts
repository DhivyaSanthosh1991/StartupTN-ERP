import { parseBiometricLog } from '../src/attendance/biometric-parse';
import { csvCells } from '../src/attendance/biometric-report';
import { istInstant } from '../src/common/dates';
import { TestEnv, createTestEnv } from './helpers';

// The shape of the machine software's "Monthly Status Report" once saved as CSV (made-up people).
const REPORT = [
  ',Monthly Status Report (Detailed Work Duration),,,,,,,',
  ',,,,,,,,',
  ',Nov 01 2026  To  Nov 06 2026,,,,,,,',
  'Company:,,,,Default,,,,Printed On : Nov 11 2026 16:27',
  'Days,,1 S,2 M,,3 T,4 W,5 Th,6 F',
  'Department:,,,Default,,,,,',
  'Employee:,,,"1 : Asha, K",,,,, Total Work Duration',
  'Status,,WO,P,,P,P,A,P',
  'InTime,,,10:34,,09:03,,,09:15',
  'OutTime,,,19:03,,21:50,18:00,,18:44',
  'Duration,,00:00,8:29,,8:00,,,8:00',
  'Employee:,,,STN042 : Bala,,,,,',
  'Status,,WO,A,,A,A,A,A',
  'InTime,,,,,,,,',
  'OutTime,,,,,,,,',
  'Employee:,,,002 : Chitra,,,,,',
  'Status,,WO,P,,P,P,P,P',
  'InTime,,,09:00,,09:00,09:00,09:00,09:00',
  'OutTime,,,17:30,,17:30,08:00,17:30,17:30',
].join('\n');

describe('the Excel monthly status report', () => {
  it('reads the cells of a CSV line, with quoted commas', () => {
    expect(csvCells('a,"b, c",,d ,"e ""q"""')).toEqual(['a', 'b, c', '', 'd', 'e "q"']);
  });

  it('gives an in-punch and an out-punch for each day with times, in India time', () => {
    const r = parseBiometricLog(REPORT);
    const asha = r.punches.filter((p) => p.code === '1');
    expect(asha.map((p) => `${p.direction} ${p.at.toISOString()}`)).toEqual([
      'in 2026-11-02T05:04:00.000Z', 'out 2026-11-02T13:33:00.000Z',
      'in 2026-11-03T03:33:00.000Z', 'out 2026-11-03T16:20:00.000Z',
      'out 2026-11-04T12:30:00.000Z', // an out-time with no in-time is kept as the one punch there is
      'in 2026-11-06T03:45:00.000Z', 'out 2026-11-06T13:14:00.000Z',
    ]);
    expect(asha[0].at.getTime()).toBe(istInstant('2026-11-02', '10:34').getTime());
  });

  it('takes the person code before the colon, with or without leading zeros or letters, and skips people who never punched', () => {
    const r = parseBiometricLog(REPORT);
    expect([...new Set(r.punches.map((p) => p.code))]).toEqual(['1', '002']);
  });

  it('refuses an out-time earlier than the in-time rather than guessing it is the next day', () => {
    const r = parseBiometricLog(REPORT);
    expect(r.rejected).toBe(1);
    expect(r.samples[0]).toContain('002 2026-11-04 out 08:00 is before in 09:00');
    expect(r.punches.filter((p) => p.code === '002')).toHaveLength(9); // five ins and four outs
  });

  it('follows the days into the next month', () => {
    const r = parseBiometricLog([
      ',Monthly Status Report,,,', ',Oct 30 2026  To  Nov 02 2026,,,', 'Days,,30 F,31 S,1 S,2 M',
      'Employee:,,,7 : Dev,,', 'InTime,,09:00,,,09:10', 'OutTime,,17:00,,,17:10',
    ].join('\n'));
    expect(r.punches.map((p) => new Date(p.at.getTime() + 19_800_000).toISOString().slice(0, 10))).toEqual(['2026-10-30', '2026-10-30', '2026-11-02', '2026-11-02']);
  });

  it('says so when the date line is missing, and reads a cell that is not a time as unreadable', () => {
    const r = parseBiometricLog([',Monthly Status Report,,', 'Days,,1 S,2 M', 'Employee:,,,7 : Dev', 'InTime,,09:00,late', 'OutTime,,17:00,'].join('\n'));
    expect(r.punches).toEqual([]);
    expect(r.rejected).toBeGreaterThan(0);
    expect(r.samples[0]).toContain('date line');
  });

  describe('uploaded in the portal', () => {
    let env: TestEnv;
    beforeAll(async () => { env = await createTestEnv(); });
    beforeEach(async () => { await env.reset(); await env.db.query('delete from holidays'); });
    afterAll(() => env.close());

    it('brings attendance up to date for people on the machine, and lists codes nobody has yet', async () => {
      await env.db.query(`update employees set attendance_method = 'biometric', biometric_code = '1' where id = $1`, [env.ids.priya]);
      const hr = await env.as('hema');
      const res = await hr.post('/api/admin/attendance/biometric/import').set('Content-Type', 'text/csv').send(REPORT);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ inserted: 16, unmatched: 9, rejected: 1 });
      const day = await env.db.one(`select status, worked_minutes from attendance_days where employee_id = $1 and work_date = '2026-11-02'`, [env.ids.priya]);
      expect(day).toMatchObject({ worked_minutes: 509 });
      // again: no harm
      const again = await hr.post('/api/admin/attendance/biometric/import').set('Content-Type', 'text/csv').send(REPORT);
      expect(again.body).toMatchObject({ inserted: 0, duplicates: 16 });
    });
  });
});
