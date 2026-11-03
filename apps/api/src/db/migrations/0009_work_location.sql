-- Each person's own place of work (one of the office and field locations). A check-in is judged against
-- this place: being at a different location is flagged, unless it is an approved on-duty day.
alter table employees add column if not exists work_location_id uuid references geofences(id) on delete set null;
