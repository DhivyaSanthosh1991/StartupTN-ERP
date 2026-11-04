-- On duty: the punches made on an approved on-duty day are tied to that duty, so the approver can see
-- when the person reached the site and left it. After the duty, a person may ask to go straight home.
alter table attendance_events add column if not exists od_request_id uuid references od_requests(id) on delete set null;

alter table approval_workflows drop constraint if exists approval_workflows_request_type_check;
alter table approval_workflows add constraint approval_workflows_request_type_check
  check (request_type in ('leave','od','permission','regularisation','od_home'));
alter table approval_requests drop constraint if exists approval_requests_request_type_check;
alter table approval_requests add constraint approval_requests_request_type_check
  check (request_type in ('leave','od','permission','regularisation','od_home'));

create table if not exists od_home_requests (
  id                    uuid primary key default gen_random_uuid(),
  employee_id           uuid not null references employees(id),
  od_request_id         uuid references od_requests(id),
  work_date             date not null,
  left_site_at          timestamptz not null,
  from_latitude         double precision,
  from_longitude        double precision,
  distance_to_office_m  integer,
  travel_minutes        integer,
  reason                text,
  status                text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  approval_request_id   uuid references approval_requests(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
-- One live request a day: a rejected or cancelled one can be replaced.
create unique index if not exists od_home_one_per_day on od_home_requests (employee_id, work_date) where status in ('pending','approved');

insert into approval_workflows (request_type, name) values ('od_home', 'Going home after duty')
  on conflict (request_type) do nothing;
insert into approval_workflow_steps (workflow_id, step_order, approver_kind, min_days, sla_hours)
  select w.id, 1, 'reporting_manager', null, 24 from approval_workflows w where w.request_type = 'od_home'
  on conflict (workflow_id, step_order) do nothing;
