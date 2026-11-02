-- How each person's attendance is taken, and the punches that come from the biometric machine at head office.
--
--   selfie     : check in and out in the portal with a selfie and the phone's location (the hubs)
--   biometric  : the fingerprint/face machine at head office; the portal only takes over on approved on-duty days

alter table employees
  add column attendance_method text not null default 'selfie'
             check (attendance_method in ('selfie', 'biometric')),
  add column biometric_code    text;     -- the person's code on the machine (often the same as emp_code)

create unique index employees_biometric_code_uidx on employees (biometric_code) where biometric_code is not null;

-- Punches from the machine are events like any other, but have no photo and no GPS position.
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'attendance_events'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%source%' loop
    execute format('alter table attendance_events drop constraint %I', c.conname);
  end loop;
end $$;

alter table attendance_events
  add constraint attendance_events_source_check
    check (source in ('web', 'mobile', 'regularisation', 'admin', 'biometric')),
  add constraint attendance_events_location_check
    check (source in ('regularisation', 'admin', 'biometric') or (latitude is not null and longitude is not null));

-- Every punch the machine reported, exactly as received. Attendance events are worked out from these
-- (first punch of the day is the check-in, last is the check-out), so the raw record is never lost.
create table biometric_punches (
  id              uuid primary key default gen_random_uuid(),
  device_serial   text not null,
  biometric_code  text not null,
  punched_at      timestamptz not null,
  direction       text,                              -- what the machine called it, if it says; not used to pair punches
  employee_id     uuid references employees(id),     -- null until someone has this code
  imported_at     timestamptz not null default now(),
  unique (device_serial, biometric_code, punched_at)
);
create index biometric_punches_emp_idx on biometric_punches (employee_id, punched_at);
create index biometric_punches_unmatched_idx on biometric_punches (biometric_code) where employee_id is null;

-- One row per import run (a file HR uploaded, or a pull from the machine's Web API).
create table biometric_imports (
  id            uuid primary key default gen_random_uuid(),
  source        text not null check (source in ('file', 'api')),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  range_from    date,
  range_to      date,
  device_serial text,
  actor_id      uuid references employees(id),
  rows_read     integer not null default 0,
  inserted      integer not null default 0,
  duplicates    integer not null default 0,
  unmatched     integer not null default 0,
  rejected      integer not null default 0,
  status        text not null default 'running' check (status in ('running', 'done', 'failed')),
  message       text
);
create index biometric_imports_started_idx on biometric_imports (started_at desc);

-- When each machine was last asked for its punches, and how that went (shown to HR on Attendance setup).
create table biometric_devices (
  device_serial    text primary key,
  last_checked_at  timestamptz,
  last_ok_at       timestamptz,
  last_error       text
);
