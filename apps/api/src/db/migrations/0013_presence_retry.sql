-- A check nobody answered is asked once more later; the second one points back at the first.
alter table presence_checks add column if not exists retry_of uuid references presence_checks(id) on delete set null;
create unique index if not exists presence_checks_one_retry on presence_checks (retry_of) where retry_of is not null;
