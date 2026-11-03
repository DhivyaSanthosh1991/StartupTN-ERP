-- Leave rules that need more than "days per year": balances that roll into the next year for a
-- limited time, leave tied to an event (maternity, paternity), and leave for only some people.
-- Nothing here changes existing leave types: every new column defaults to the old behaviour.
-- The StartupTN policy values themselves are loaded by `npm run db:leave-policy`.

alter table employees add column if not exists gender text check (gender in ('female','male','other'));

alter table leave_types drop constraint if exists leave_types_accrual_check;
alter table leave_types add constraint leave_types_accrual_check check (accrual in ('upfront','monthly','event'));

-- cap     = old behaviour: at year end carry over up to carry_forward_max and lapse the rest.
-- rolling = last year's balance stays in last year, is used first, and lapses carry_valid_months
--           months after that year ends (0 = lapses on the last day of the year).
alter table leave_types add column if not exists carry_mode text not null default 'cap' check (carry_mode in ('cap','rolling'));
alter table leave_types add column if not exists carry_valid_months integer not null default 0 check (carry_valid_months between 0 and 12);

-- Who the type is for, beyond employment type: job titles (compared ignoring capitals). Null = everyone.
alter table leave_types add column if not exists only_designations text[];
alter table leave_types add column if not exists except_designations text[];
alter table leave_types add column if not exists only_gender text check (only_gender in ('female','male'));

-- Event leave (accrual = 'event'): annual_entitlement is the most days one request may take.
alter table leave_types add column if not exists max_times integer check (max_times > 0);
alter table leave_types add column if not exists min_service_days integer check (min_service_days >= 0);
alter table leave_types add column if not exists count_calendar_days boolean not null default false;
