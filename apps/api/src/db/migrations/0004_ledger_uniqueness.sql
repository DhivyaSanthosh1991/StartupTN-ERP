-- Safety net for the leave ledger: the application already checks before it credits, under a lock,
-- but the database should make a double credit impossible whatever the code does.
create unique index if not exists leave_ledger_once_per_year
  on leave_ledger (employee_id, leave_type_id, year, entry_type)
  where entry_type in ('opening', 'carry_forward', 'lapse');

create unique index if not exists leave_ledger_one_accrual_per_month
  on leave_ledger (employee_id, leave_type_id, year, note)
  where entry_type = 'accrual';
