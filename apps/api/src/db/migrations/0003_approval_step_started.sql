-- SLA reminders and escalation need, per step: when it became active, and how long it may stay open.
alter table approval_steps add column started_at timestamptz;
alter table approval_steps add column sla_hours integer not null default 48 check (sla_hours > 0);
update approval_steps set started_at = now() where status = 'pending' and started_at is null;

-- Monthly accrual produces fractions such as 1.25 days.
alter table leave_ledger alter column days type numeric(6,2);
