-- Breaks (lunch and other) and random "are you at your place of work" checks.
create table if not exists work_breaks (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references employees(id),
  work_date    date not null,
  kind         text not null check (kind in ('lunch','other')),
  note         text,
  started_at   timestamptz not null,
  ended_at     timestamptz,
  created_at   timestamptz not null default now()
);
create unique index if not exists work_breaks_one_open on work_breaks (employee_id) where ended_at is null;
create index if not exists work_breaks_day_idx on work_breaks (employee_id, work_date);

create table if not exists presence_checks (
  id               uuid primary key default gen_random_uuid(),
  employee_id      uuid not null references employees(id),
  work_date        date not null,
  asked_at         timestamptz not null,
  expires_at       timestamptz not null,
  answered_at      timestamptz,
  latitude         double precision,
  longitude        double precision,
  accuracy_m       double precision,
  geofence_id      uuid references geofences(id) on delete set null,
  distance_m       integer,
  status           text not null default 'pending' check (status in ('pending','ok','outside','missed')),
  created_at       timestamptz not null default now()
);
create index if not exists presence_checks_day_idx on presence_checks (employee_id, work_date);
create unique index if not exists presence_checks_one_pending on presence_checks (employee_id) where status = 'pending';
