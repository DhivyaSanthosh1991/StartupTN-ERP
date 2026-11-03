-- Selfie check-in: a live photo is taken at each punch and stored beside the GPS fix.
-- The photo itself lives in object storage (S3 in production); the database only keeps its key.

alter table attendance_events
  add column selfie_key       text,          -- null: no photo (older punch, correction, or selfies switched off)
  add column selfie_purged_at timestamptz;   -- set when the photo was deleted after the retention period

-- DPDP: a photo of a face is personal data, so it has its own consent next to the location consent.
alter table employees
  add column photo_consent_at timestamptz;

-- The retention job looks for photos older than the retention period.
create index attendance_events_selfie_idx on attendance_events (event_at) where selfie_key is not null;

-- The two new organisation settings (selfie_required, selfie_retention_days) have their defaults in code,
-- like attendance_start_date, so there is no row to insert here.
