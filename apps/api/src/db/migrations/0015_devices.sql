-- Phones that have the app installed, so the server can send them notifications (presence checks).
create table devices (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid not null references employees(id) on delete cascade,
  push_token    text not null,
  platform      text not null check (platform in ('android', 'ios')),
  app_version   text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  unique (push_token)
);
create index devices_employee_idx on devices (employee_id);
