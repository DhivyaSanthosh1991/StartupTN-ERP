-- StartupTN ERP — Phase 1 schema
-- People, attendance, leave, OD, approvals, documents, audit.
-- All timestamps are timestamptz; "work_date" columns are calendar dates in Asia/Kolkata.

-- ---------------------------------------------------------------- people

create table departments (
  id                uuid primary key default gen_random_uuid(),
  name              text not null unique,
  head_employee_id  uuid,                      -- FK added after employees exists
  created_at        timestamptz not null default now()
);

create table employees (
  id                    uuid primary key default gen_random_uuid(),
  emp_code              text not null unique,
  full_name             text not null,
  official_email        text not null,
  phone                 text,
  designation           text,
  department_id         uuid references departments(id),
  employment_type       text not null default 'permanent'
                        check (employment_type in ('permanent','contract','consultant','intern')),
  date_of_joining       date,
  date_of_birth         date,
  reporting_manager_id  uuid references employees(id),
  status                text not null default 'active'
                        check (status in ('active','inactive','exited')),
  exit_date             date,
  photo_url             text,
  location_consent_at   timestamptz,           -- DPDP: consent to GPS capture at punch time
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (reporting_manager_id is null or reporting_manager_id <> id)
);
create unique index employees_email_uidx on employees (lower(official_email));
create index employees_manager_idx on employees (reporting_manager_id);
create index employees_department_idx on employees (department_id);

alter table departments
  add constraint departments_head_fk foreign key (head_employee_id) references employees(id);

-- Everyone is an "employee"; a reporting manager is anyone with direct reports.
-- This table holds the elevated roles only.
create table employee_roles (
  employee_id  uuid not null references employees(id) on delete cascade,
  role         text not null check (role in ('hod','md','hr_admin','finance','super_admin')),
  primary key (employee_id, role)
);

create table org_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

create table holidays (
  id            uuid primary key default gen_random_uuid(),
  holiday_date  date not null unique,
  name          text not null,
  optional      boolean not null default false
);

create table notices (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  body          text not null,
  published_at  timestamptz not null default now(),
  expires_on    date,
  created_by    uuid references employees(id)
);

-- ------------------------------------------------------------ attendance

create table geofences (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  kind        text not null default 'office' check (kind in ('office','field')),
  latitude    double precision not null check (latitude between -90 and 90),
  longitude   double precision not null check (longitude between -180 and 180),
  radius_m    integer not null check (radius_m between 10 and 50000),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table attendance_events (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null references employees(id),
  event_type      text not null check (event_type in ('check_in','check_out')),
  event_at        timestamptz not null default now(),
  work_date       date not null,
  latitude        double precision,
  longitude       double precision,
  accuracy_m      double precision,
  geofence_id     uuid references geofences(id),
  within_geofence boolean,
  flags           text[] not null default '{}',
  source          text not null default 'web'
                  check (source in ('web','mobile','regularisation','admin')),
  note            text,
  created_at      timestamptz not null default now(),
  check (source in ('regularisation','admin') or (latitude is not null and longitude is not null))
);
create index attendance_events_emp_day_idx on attendance_events (employee_id, work_date, event_at);

create table attendance_days (
  employee_id     uuid not null references employees(id),
  work_date       date not null,
  first_in        timestamptz,
  last_out        timestamptz,
  worked_minutes  integer not null default 0,
  status          text not null
                  check (status in ('present','half_day','absent','leave','od','holiday','weekly_off','incomplete')),
  late            boolean not null default false,
  flags           text[] not null default '{}',
  updated_at      timestamptz not null default now(),
  primary key (employee_id, work_date)
);
create index attendance_days_date_idx on attendance_days (work_date);

-- ------------------------------------------------------------ approvals

create table approval_workflows (
  id            uuid primary key default gen_random_uuid(),
  request_type  text not null unique
                check (request_type in ('leave','od','permission','regularisation')),
  name          text not null,
  active        boolean not null default true
);

create table approval_workflow_steps (
  id                    uuid primary key default gen_random_uuid(),
  workflow_id           uuid not null references approval_workflows(id) on delete cascade,
  step_order            integer not null check (step_order >= 1),
  approver_kind         text not null
                        check (approver_kind in ('reporting_manager','department_head','role','employee')),
  approver_role         text,
  approver_employee_id  uuid references employees(id),
  min_days              numeric(5,1),            -- step applies only when request size >= min_days
  sla_hours             integer not null default 48 check (sla_hours > 0),
  unique (workflow_id, step_order),
  check (approver_kind <> 'role' or approver_role is not null),
  check (approver_kind <> 'employee' or approver_employee_id is not null)
);

create table approval_requests (
  id            uuid primary key default gen_random_uuid(),
  request_type  text not null check (request_type in ('leave','od','permission','regularisation')),
  ref_id        uuid not null,
  requester_id  uuid not null references employees(id),
  workflow_id   uuid references approval_workflows(id),
  status        text not null default 'pending'
                check (status in ('pending','approved','rejected','cancelled')),
  summary       text not null,
  size          numeric(5,1) not null default 1,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz,
  unique (request_type, ref_id)
);
create index approval_requests_requester_idx on approval_requests (requester_id, status);

create table approval_steps (
  id                   uuid primary key default gen_random_uuid(),
  approval_request_id  uuid not null references approval_requests(id) on delete cascade,
  step_order           integer not null,
  approver_id          uuid references employees(id),
  approver_role        text,
  status               text not null default 'waiting'
                       check (status in ('waiting','pending','approved','rejected','skipped','escalated')),
  acted_by             uuid references employees(id),
  acted_at             timestamptz,
  comment              text,
  due_at               timestamptz,
  reminded_at          timestamptz,
  unique (approval_request_id, step_order),
  check (approver_id is not null or approver_role is not null)
);
create index approval_steps_pending_idx on approval_steps (status, approver_id);
create index approval_steps_due_idx on approval_steps (due_at) where status = 'pending';

create table approval_delegations (
  id            uuid primary key default gen_random_uuid(),
  delegator_id  uuid not null references employees(id),
  delegate_id   uuid not null references employees(id),
  from_date     date not null,
  to_date       date not null,
  created_at    timestamptz not null default now(),
  check (to_date >= from_date),
  check (delegator_id <> delegate_id)
);
create index approval_delegations_delegate_idx on approval_delegations (delegate_id, from_date, to_date);

-- ----------------------------------------------------------------- leave

create table leave_types (
  id                             uuid primary key default gen_random_uuid(),
  code                           text not null unique,
  name                           text not null,
  annual_entitlement             numeric(5,1) not null default 0,
  accrual                        text not null default 'upfront' check (accrual in ('upfront','monthly')),
  carry_forward_max              numeric(5,1) not null default 0,
  allow_half_day                 boolean not null default true,
  paid                           boolean not null default true,
  applicable_employment_types    text[] not null default '{permanent,contract}',
  requires_document_after_days   numeric(5,1),
  active                         boolean not null default true,
  sort_order                     integer not null default 0
);

-- Balance = sum(days) per (employee, leave type, leave year). Every change is a row.
create table leave_ledger (
  id             bigserial primary key,
  employee_id    uuid not null references employees(id),
  leave_type_id  uuid not null references leave_types(id),
  year           integer not null,
  entry_type     text not null
                 check (entry_type in ('opening','accrual','carry_forward','adjustment','debit','reversal','lapse')),
  days           numeric(5,1) not null,
  ref_type       text,
  ref_id         uuid,
  note           text,
  created_by     uuid references employees(id),
  created_at     timestamptz not null default now()
);
create index leave_ledger_balance_idx on leave_ledger (employee_id, leave_type_id, year);
create index leave_ledger_ref_idx on leave_ledger (ref_type, ref_id);

create table leave_requests (
  id                    uuid primary key default gen_random_uuid(),
  employee_id           uuid not null references employees(id),
  leave_type_id         uuid not null references leave_types(id),
  from_date             date not null,
  to_date               date not null,
  day_part              text not null default 'full' check (day_part in ('full','first_half','second_half')),
  days                  numeric(5,1) not null check (days > 0),
  reason                text not null,
  status                text not null default 'pending'
                        check (status in ('pending','approved','rejected','cancelled')),
  approval_request_id   uuid references approval_requests(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (to_date >= from_date),
  check (day_part = 'full' or from_date = to_date)
);
create index leave_requests_emp_idx on leave_requests (employee_id, from_date);
create index leave_requests_range_idx on leave_requests (from_date, to_date) where status in ('pending','approved');

-- -------------------------------------------------------------------- OD

create table od_requests (
  id                    uuid primary key default gen_random_uuid(),
  employee_id           uuid not null references employees(id),
  kind                  text not null check (kind in ('od','permission')),
  from_date             date not null,
  to_date               date not null,
  from_time             time,
  to_time               time,
  location              text,
  purpose               text not null,
  status                text not null default 'pending'
                        check (status in ('pending','approved','rejected','cancelled')),
  approval_request_id   uuid references approval_requests(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (to_date >= from_date),
  check (kind = 'od' or (from_date = to_date and from_time is not null and to_time is not null and to_time > from_time))
);
create index od_requests_emp_idx on od_requests (employee_id, from_date);
create index od_requests_range_idx on od_requests (from_date, to_date) where status in ('pending','approved');

create table regularisation_requests (
  id                    uuid primary key default gen_random_uuid(),
  employee_id           uuid not null references employees(id),
  work_date             date not null,
  check_in_time         time,
  check_out_time        time,
  reason                text not null,
  status                text not null default 'pending'
                        check (status in ('pending','approved','rejected','cancelled')),
  approval_request_id   uuid references approval_requests(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (check_in_time is not null or check_out_time is not null),
  check (check_in_time is null or check_out_time is null or check_out_time > check_in_time)
);
create index regularisation_emp_idx on regularisation_requests (employee_id, work_date);

-- ------------------------------------------------------------- documents

create table document_categories (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,
  name             text not null,
  expiry_tracked   boolean not null default false,
  sort_order       integer not null default 0
);

create table documents (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid not null references employees(id),
  category_id    uuid not null references document_categories(id),
  title          text not null,
  storage_key    text not null unique,
  file_name      text not null,
  content_type   text not null,
  size_bytes     bigint,
  expires_on     date,
  visibility     text not null default 'employee_and_hr' check (visibility in ('employee_and_hr','hr_only')),
  status         text not null default 'pending_upload' check (status in ('pending_upload','available','deleted')),
  uploaded_by    uuid not null references employees(id),
  created_at     timestamptz not null default now(),
  deleted_at     timestamptz
);
create index documents_emp_idx on documents (employee_id) where status = 'available';
create index documents_expiry_idx on documents (expires_on) where status = 'available' and expires_on is not null;

-- ----------------------------------------------------------------- email

create table email_outbox (
  id           uuid primary key default gen_random_uuid(),
  to_address   text not null,
  subject      text not null,
  body_text    text not null,
  body_html    text,
  status       text not null default 'queued' check (status in ('queued','sent','failed')),
  attempts     integer not null default 0,
  last_error   text,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);
create index email_outbox_queued_idx on email_outbox (created_at) where status = 'queued';

-- ----------------------------------------------------------------- audit

create table audit_log (
  id           bigserial primary key,
  actor_id     uuid,
  action       text not null,
  entity_type  text not null,
  entity_id    text,
  before_data  jsonb,
  after_data   jsonb,
  ip_address   text,
  created_at   timestamptz not null default now()
);
create index audit_log_entity_idx on audit_log (entity_type, entity_id);
create index audit_log_actor_idx on audit_log (actor_id, created_at);

-- Append-only: nobody can edit or delete audit rows through SQL either.
create function audit_log_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end $$;
create trigger audit_log_no_update before update or delete on audit_log
  for each row execute function audit_log_immutable();
