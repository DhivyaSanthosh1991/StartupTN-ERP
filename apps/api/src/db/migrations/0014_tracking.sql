-- Location while someone is checked in: sparse readings and "left the office" alerts for HR.
create table if not exists location_pings (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references employees(id),
  work_date    date not null,
  recorded_at  timestamptz not null,
  latitude     double precision not null,
  longitude    double precision not null,
  accuracy_m   double precision,
  geofence_id  uuid references geofences(id) on delete set null,
  within_fence boolean,
  distance_m   integer,
  source       text not null default 'web' check (source in ('web','app'))
);
create index if not exists location_pings_day_idx on location_pings (employee_id, work_date, recorded_at);
create index if not exists location_pings_age_idx on location_pings (recorded_at);

create table if not exists away_alerts (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid not null references employees(id),
  work_date     date not null,
  left_at       timestamptz not null,
  raised_at     timestamptz not null,
  returned_at   timestamptz,
  reason_kind   text check (reason_kind in ('official','break','personal','other')),
  reason_note   text,
  explained_at  timestamptz,
  created_at    timestamptz not null default now()
);
-- one alert at a time per person until they are back
create unique index if not exists away_alerts_one_open on away_alerts (employee_id) where returned_at is null;
create index if not exists away_alerts_day_idx on away_alerts (work_date, raised_at);
