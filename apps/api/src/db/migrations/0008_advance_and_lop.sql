-- Advance leave and automatic loss of pay.
--   advance_days        how many days a person may take before they have earned them. The balance goes
--                       negative, and later monthly credits pay it back before anything builds up.
--   lop_when_exhausted  leave beyond balance + advance is not refused: those days are loss of pay.
--   leave_requests.lop_days  the part of a request that is loss of pay (it takes nothing from any balance).
alter table leave_types add column if not exists advance_days numeric(4,1) not null default 0 check (advance_days >= 0);
alter table leave_types add column if not exists lop_when_exhausted boolean not null default false;
alter table leave_requests add column if not exists lop_days numeric(6,2) not null default 0 check (lop_days >= 0);
