import { Injectable } from '@nestjs/common';
import { AuthUser } from '../common/auth.types';
import { addDays, todayIst } from '../common/dates';
import { Db } from '../db/db.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { AttendanceService } from '../attendance/attendance.service';
import { DocumentsService } from '../documents/documents.service';
import { LeaveService } from '../leave/leave.service';
import { OrgService } from '../org/org.service';

const HOLIDAY_LOOKAHEAD_DAYS = 120;
const DOCUMENT_LOOKAHEAD_DAYS = 30;

/**
 * Everything the home page needs, in one round trip. Each part reuses the module that owns the
 * data, so the dashboard can never disagree with the screen it links to.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly db: Db,
    private readonly attendance: AttendanceService,
    private readonly leave: LeaveService,
    private readonly approvals: ApprovalsService,
    private readonly documents: DocumentsService,
    private readonly org: OrgService,
  ) {}

  async forUser(user: AuthUser, now: Date = new Date()) {
    const today = todayIst(now);
    const month = today.slice(0, 7);

    const [attendanceToday, monthView, balances, pending, upcoming, inbox, holidays, notices, away, expiring, team] = await Promise.all([
      this.attendance.today(user, now),
      this.attendance.monthFor(user, user.id, month),
      this.leave.balances(user.id),
      this.pendingCounts(user.id),
      this.upcomingTimeOff(user.id, today),
      this.approvals.inbox(user),
      this.upcomingHolidays(today),
      this.org.notices(),
      this.awayToday(user, today),
      this.documents.expiring(user, DOCUMENT_LOOKAHEAD_DAYS, false),
      this.teamToday(user, today),
    ]);

    return {
      date: today,
      attendance: attendanceToday,
      month: { month, summary: monthView.summary },
      leaveBalances: balances,
      myRequests: { pending, upcoming },
      approvals: {
        waiting: inbox.length,
        overdue: inbox.filter((i) => i.dueAt && new Date(i.dueAt).getTime() < now.getTime()).length,
        oldest: inbox.slice(0, 3).map((i) => ({
          approvalRequestId: i.approvalRequestId, typeLabel: i.typeLabel, summary: i.summary,
          requester: i.requester.fullName, dueAt: i.dueAt,
        })),
      },
      team,
      awayToday: away,
      holidays,
      notices: notices.slice(0, 5),
      expiringDocuments: expiring,
    };
  }

  /** How many of my requests are still waiting on someone. */
  private async pendingCounts(employeeId: string) {
    const r = await this.db.one(
      `select
         (select count(*) from leave_requests where employee_id = $1 and status = 'pending') as leave,
         (select count(*) from od_requests where employee_id = $1 and kind = 'od' and status = 'pending') as od,
         (select count(*) from od_requests where employee_id = $1 and kind = 'permission' and status = 'pending') as permission,
         (select count(*) from regularisation_requests where employee_id = $1 and status = 'pending') as regularisation`,
      [employeeId]);
    const n = (v: unknown) => Number(v ?? 0);
    const counts = { leave: n(r?.leave), od: n(r?.od), permission: n(r?.permission), regularisation: n(r?.regularisation) };
    return { ...counts, total: counts.leave + counts.od + counts.permission + counts.regularisation };
  }

  /** My next few approved absences and duties, soonest first. */
  private async upcomingTimeOff(employeeId: string, today: string) {
    const rows = await this.db.rows(
      `select * from (
         select 'leave' as kind, lr.id, lr.from_date, lr.to_date, lt.name as label, lr.day_part, null::time as from_time, null::time as to_time
           from leave_requests lr join leave_types lt on lt.id = lr.leave_type_id
          where lr.employee_id = $1 and lr.status = 'approved' and lr.to_date >= $2
         union all
         select o.kind, o.id, o.from_date, o.to_date, coalesce(o.location, o.purpose), 'full', o.from_time, o.to_time
           from od_requests o
          where o.employee_id = $1 and o.status = 'approved' and o.to_date >= $2
       ) x order by from_date, to_date limit 5`, [employeeId, today]);
    return rows.map((r) => ({
      kind: r.kind as 'leave' | 'od' | 'permission', id: r.id as string, from: r.from_date as string, to: r.to_date as string,
      label: r.label as string, dayPart: r.day_part as string,
      fromTime: r.from_time ? (r.from_time as string).slice(0, 5) : null, toTime: r.to_time ? (r.to_time as string).slice(0, 5) : null,
    }));
  }

  private async upcomingHolidays(today: string) {
    const rows = await this.db.rows(
      `select holiday_date as date, name, optional from holidays
        where holiday_date between $1 and $2 order by holiday_date limit 5`,
      [today, addDays(today, HOLIDAY_LOOKAHEAD_DAYS)]);
    return rows.map((h) => ({ date: h.date as string, name: h.name as string, optional: h.optional as boolean }));
  }

  /**
   * Colleagues who are out today: the people in my department, under my manager, or reporting to me.
   * Only the fact that they are away is shown, not the leave type or the reason.
   */
  private async awayToday(user: AuthUser, today: string) {
    const rows = await this.db.rows(
      `select e.id, e.full_name, e.designation,
              case when exists (select 1 from leave_requests l where l.employee_id = e.id and l.status = 'approved'
                                  and $2 between l.from_date and l.to_date) then 'leave' else 'od' end as away,
              (select l.day_part from leave_requests l where l.employee_id = e.id and l.status = 'approved'
                  and $2 between l.from_date and l.to_date limit 1) as day_part
         from employees e
        where e.status = 'active' and e.id <> $1
          and ( ($3::uuid is not null and e.department_id = $3)
                or ($4::uuid is not null and e.reporting_manager_id = $4)
                or e.reporting_manager_id = $1 )
          and ( exists (select 1 from leave_requests l where l.employee_id = e.id and l.status = 'approved'
                          and $2 between l.from_date and l.to_date)
                or exists (select 1 from od_requests o where o.employee_id = e.id and o.kind = 'od' and o.status = 'approved'
                             and $2 between o.from_date and o.to_date) )
        order by e.full_name`,
      [user.id, today, user.departmentId, user.reportingManagerId]);
    return rows.map((r) => ({
      employeeId: r.id as string, fullName: r.full_name as string, designation: r.designation as string | null,
      away: r.away as 'leave' | 'od', dayPart: (r.day_part as string | null) ?? 'full',
    }));
  }

  /**
   * For managers and HR: how the people they look after are doing today. Null for everyone else.
   * Each person lands in exactly one of onLeave, onDuty, present, dayOff or notYetIn.
   */
  private async teamToday(user: AuthUser, today: string) {
    const people = (await this.attendance.teamDay(user, today)).filter((p) => p.employeeId !== user.id);
    if (!people.length) return null;
    const out = { total: people.length, present: 0, checkedInNow: 0, onLeave: 0, onDuty: 0, dayOff: 0, notYetIn: 0 };
    for (const p of people) {
      const came = p.firstIn !== null;
      if (p.status === 'leave' || (!came && p.flags.includes('half_day_leave'))) out.onLeave++;
      else if (p.status === 'od') out.onDuty++;
      else if (came) {
        out.present++;
        if (p.status === 'incomplete') out.checkedInNow++; // still in: no check-out yet
      } else if (p.status === 'holiday' || p.status === 'weekly_off') out.dayOff++;
      else out.notYetIn++;
    }
    return out;
  }
}
