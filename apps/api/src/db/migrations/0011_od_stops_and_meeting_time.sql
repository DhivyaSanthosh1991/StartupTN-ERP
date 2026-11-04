-- On duty can have a fixed reporting time at the venue, and more than one place in a day.
alter table od_requests add column if not exists meeting_time time;

create table if not exists od_stops (
  id             uuid primary key default gen_random_uuid(),
  od_request_id  uuid not null references od_requests(id) on delete cascade,
  employee_id    uuid not null references employees(id),
  work_date      date not null,
  location       text not null,
  purpose        text,
  meeting_time   time,
  created_at     timestamptz not null default now()
);
create index if not exists od_stops_day_idx on od_stops (employee_id, work_date, created_at);

alter table attendance_events add column if not exists od_stop_id uuid references od_stops(id) on delete set null;
