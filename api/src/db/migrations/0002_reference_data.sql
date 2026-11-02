-- Reference data. Safe to re-run. Every value below is a STARTING POINT:
-- HR must confirm leave types, entitlements, working hours and approval chains
-- before go-live (see "Decisions needed" in the architecture doc).

insert into org_settings (key, value) values
  ('work_start',               '"09:30"'),
  ('grace_minutes',            '15'),
  ('full_day_minutes',         '480'),
  ('half_day_minutes',         '240'),
  ('weekly_off_days',          '[0,6]'),     -- 0 = Sunday ... 6 = Saturday
  ('leave_year_start_month',   '1'),         -- 1 = calendar year, 4 = April-March
  ('leave_backdate_days',      '7'),         -- how far back leave may be applied
  ('permission_max_minutes',   '120'),
  ('permission_monthly_limit', '2'),
  ('geofence_low_accuracy_m',  '100')        -- GPS fix worse than this is flagged
on conflict (key) do nothing;

insert into document_categories (code, name, expiry_tracked, sort_order) values
  ('id_proof',      'ID proof',                false, 1),
  ('address_proof', 'Address proof',           false, 2),
  ('education',     'Education certificates',  false, 3),
  ('experience',    'Experience letters',      false, 4),
  ('offer_letter',  'Offer / appointment letter', false, 5),
  ('contract',      'Contract',                true,  6),
  ('certificate',   'Certificates and licences', true, 7),
  ('other',         'Other',                   false, 8)
on conflict (code) do nothing;

insert into leave_types
  (code, name, annual_entitlement, accrual, carry_forward_max, allow_half_day, paid,
   applicable_employment_types, requires_document_after_days, sort_order)
values
  ('CL',  'Casual Leave',  12, 'upfront',  0,  true,  true,  '{permanent,contract}', null, 1),
  ('EL',  'Earned Leave',  15, 'monthly',  15, true,  true,  '{permanent}',          null, 2),
  ('SL',  'Sick Leave',    12, 'upfront',  0,  true,  true,  '{permanent,contract}', 3,    3),
  ('LOP', 'Loss of Pay',   0,  'upfront',  0,  true,  false, '{permanent,contract,consultant,intern}', null, 9)
on conflict (code) do nothing;

-- Default approver chains
insert into approval_workflows (request_type, name) values
  ('leave',          'Leave approval'),
  ('od',             'On-duty approval'),
  ('permission',     'Permission approval'),
  ('regularisation', 'Attendance regularisation approval')
on conflict (request_type) do nothing;

insert into approval_workflow_steps (workflow_id, step_order, approver_kind, min_days, sla_hours)
select w.id, 1, 'reporting_manager', null, 48 from approval_workflows w where w.request_type = 'leave'
on conflict (workflow_id, step_order) do nothing;

insert into approval_workflow_steps (workflow_id, step_order, approver_kind, min_days, sla_hours)
select w.id, 2, 'department_head', 5, 48 from approval_workflows w where w.request_type = 'leave'
on conflict (workflow_id, step_order) do nothing;

insert into approval_workflow_steps (workflow_id, step_order, approver_kind, min_days, sla_hours)
select w.id, 1, 'reporting_manager', null, 48 from approval_workflows w
where w.request_type in ('od','permission','regularisation')
on conflict (workflow_id, step_order) do nothing;
