import { parseDmy, readStaffList } from '../src/db/employee-import';

const HEAD = 'Sl. No\tEmp ID\tFirst Name\t\tLast Name\tName\tDesignation\tProject Assigned\tDOJ\tWork location\tEmail ID\tContact Number';
const row = (...c: string[]) => c.join('\t');
const opts = { domain: 'startuptn.in', withPhones: false, today: '2026-11-03' };

describe('staff list import', () => {
  it('reads dates written day first', () => {
    expect(parseDmy('03/09/2026')).toBe('2026-09-03');
    expect(parseDmy('31/02/2026')).toBeNull();
    expect(parseDmy('soon')).toBeNull();
  });

  it('cleans a row and uses the project as department unless it only repeats the job title', () => {
    const r = readStaffList([HEAD,
      row('1', 'STN001', 'A', '', 'B', 'Asha  Rao ', 'Project Lead', 'Regional Hubs', '01/04/2024', 'Madurai', 'Asha@Startuptn.in ', '98 765'),
      row('2', 'TAN001', 'C', '', 'D', 'Clerk One', 'Admin Assistant', 'Admin Assistant', '', 'Chennai', 'clerk@startuptn.in', ''),
    ].join('\n'), opts);
    expect(r.people[0]).toMatchObject({ empCode: 'STN001', fullName: 'Asha Rao', email: 'asha@startuptn.in', department: 'Regional Hubs', joined: '2024-04-01', phone: null });
    expect(r.people[1].department).toBeNull();
  });

  it('keeps phone numbers only when asked', () => {
    const line = row('1', 'STN001', '', '', '', 'Asha', 'Lead', 'X', '', '', 'a@startuptn.in', '98 765-43210');
    expect(readStaffList([HEAD, line].join('\n'), opts).people[0].phone).toBeNull();
    expect(readStaffList([HEAD, line].join('\n'), { ...opts, withPhones: true }).people[0].phone).toBe('9876543210');
  });

  it('leaves out a second person who reuses an employee ID or an email, and says why', () => {
    const r = readStaffList([HEAD,
      row('1', 'TAN010', '', '', '', 'First One', 'Assistant', 'Assistant', '', '', 'one@startuptn.in', ''),
      row('2', 'TAN010', '', '', '', 'Second One', 'Housekeeping', 'Housekeeping', '', '', '', ''),
      row('3', 'TAN011', '', '', '', 'Third One', 'Assistant', 'Assistant', '', '', 'ONE@startuptn.in', ''),
    ].join('\n'), opts);
    expect(r.people.map((p) => p.fullName)).toEqual(['First One']);
    expect(r.skipped.map((s) => s.name)).toEqual(['Second One', 'Third One']);
    expect(r.skipped[0].why).toMatch(/TAN010/);
  });

  it('flags what it had to invent or change instead of hiding it', () => {
    const r = readStaffList([HEAD,
      row('1', '', '', '', '', 'No Id', 'Chair', 'Head', '03/09/2027', '', 'chair@startuptn.in', ''),
      row('2', 'STN002', '', '', '', 'No Mail', 'Driver', 'Driver', '', '', '', ''),
      row('3', 'STN003', '', '', '', 'Typo Mail', 'Lead', 'AI', '', '', 'typo@statuptn.in', ''),
    ].join('\n'), opts);
    expect(r.people[0]).toMatchObject({ empCode: 'PENDING-01', department: null, joined: null });
    expect(r.people[1].email).toBe('stn002@no-email.invalid');
    expect(r.people[2].email).toBe('typo@startuptn.in');
    expect(r.notes).toHaveLength(4);
  });

  it('refuses a list without its heading row', () => {
    expect(() => readStaffList('just,some,text', opts)).toThrow(/heading row/);
  });
});

describe('work locations from the staff list', () => {
  // Needs the database: see work-location.spec.ts
  it('reads the Work location column', () => {
    const r = readStaffList([HEAD,
      row('1', 'STN001', '', '', '', 'Asha', 'Lead', 'Regional Hubs', '', 'Trichy (Addl Charge -Thanjavur)', 'a@startuptn.in', ''),
    ].join('\n'), opts);
    expect(r.people[0].workLocation).toBe('Trichy (Addl Charge -Thanjavur)');
  });
});
