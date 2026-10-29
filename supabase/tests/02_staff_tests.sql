-- Phase 2 security and workflow tests. Runs after 01_rls_tests.sql against the same database.
-- Seed users: 01 admin, 02 manager, 03 Ama (client), 04 Kofi (client), 05 designer, 06 operator, 07 accountant, 08 customer service.
\set ON_ERROR_STOP on
\set QUIET on
set client_min_messages = notice;

create schema if not exists t;
grant usage on schema t to anon, authenticated, service_role;

create or replace function t.ok(c boolean, msg text) returns void language plpgsql as $$
begin
  if c is not true then raise exception 'FAIL: %', msg; end if;
  raise notice 'PASS  %', msg;
end $$;

create or replace function t.throws(q text, needle text) returns void language plpgsql as $$
begin
  begin
    execute q;
  exception when others then
    if sqlerrm ilike '%' || needle || '%' then
      raise notice 'PASS  rejected (%): %', needle, left(q, 78);
      return;
    end if;
    raise exception 'FAIL: wrong error for [%]: % (%)', q, sqlerrm, sqlstate;
  end;
  raise exception 'FAIL: expected error "%" but statement succeeded: %', needle, q;
end $$;

create or replace function t.login(u uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', u::text, false); end $$;

create or replace function t.u(n int) returns uuid language sql immutable as
$$ select ('00000000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid $$;

create or replace function t.job(ref text) returns uuid language sql security definer as
$$ select id from public.jobs where job_ref = ref $$;

grant execute on all functions in schema t to anon, authenticated, service_role;

create temp table j as
select t.job('JOB-2026-0002') as j2, t.job('JOB-2026-0003') as j3, t.job('JOB-2026-0004') as j4,
       (select id from organisations where slug = 'demo-print') as org;
grant select on j to anon, authenticated;

-- =================================================================== seed sanity (superuser)
select t.ok((select count(*) from role_permissions rp join roles r on r.id = rp.role_id where r.key = 'designer' and rp.permission_key = 'jobs.read_all' and r.org_id = (select org from j)) = 0, 'designer cannot see every job');
select t.ok((select count(*) from role_permissions rp join roles r on r.id = rp.role_id where r.key = 'accountant' and rp.permission_key = 'payments.confirm' and r.org_id = (select org from j)) = 1, 'accountant can confirm payments');
select t.ok((select count(*) from role_permissions rp join roles r on r.id = rp.role_id where r.key = 'customer_service' and rp.permission_key in ('payments.confirm', 'jobs.cancel', 'jobs.complete', 'jobs.assign') and r.org_id = (select org from j)) = 0, 'customer service has no restricted permissions');
select t.ok((select string_agg(status_key || '=' || required_permission, ',' order by status_key) from workflow_stages where workflow_id = (select id from workflows where org_id = (select org from j) and is_default) and required_permission is not null) = 'cancelled=jobs.cancel,completed=jobs.complete,payment_confirmed=payments.confirm', 'restricted stages are configured');
select t.ok((select count(*) from job_assignments) = 2, 'seed assigned two jobs');

-- a second business, for tenant isolation
insert into organisations (name, slug) values ('Second Press', 'second-press');
select seed_org_defaults((select id from organisations where slug = 'second-press'));
insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at) values (t.u(91), 'mgr@second.test', '{"full_name":"Other Manager"}', now(), now());
insert into org_members (org_id, user_id, role_id)
select o.id, t.u(91), r.id from organisations o join roles r on r.org_id = o.id and r.key = 'manager' where o.slug = 'second-press';

create temp table exp as
select
  (select count(*) from jobs where status <> 'draft' and org_id = (select org from j)) as nondraft,
  (select count(*) from jobs where org_id = (select org from j) and status <> 'draft' and id in (select job_id from job_assignments where user_id = t.u(5))) as designer_jobs;
grant select on exp to authenticated;

-- =================================================================== who sees what
select t.login(t.u(5));  -- designer
set role authenticated;
select t.ok((select count(*) from jobs) = 1, 'designer sees only the job assigned to her');
select t.ok((select job_ref from jobs) = 'JOB-2026-0003', 'designer sees JOB-2026-0003');
select t.ok((select count(*) from job_items) = 1, 'designer sees items of her job only');
select t.ok((select count(*) from job_status_history) = 3, 'designer sees history of her job only');
select t.ok((select count(*) from customers) = 0, 'designer has no access to the customer list');
select t.ok((select count(*) from staff_list_jobs((select org from j))) = 1, 'staff_list_jobs is limited to assigned jobs for a designer');
select t.ok((select customer_name from staff_list_jobs((select org from j))) = 'Ama Mensah', 'designer sees the customer name');
select t.ok((select (staff_job_activity((select j3 from j)) -> 'customer' ->> 'email') is null), 'designer does not get the customer email');
select t.ok((select (staff_job_activity((select j3 from j)) -> 'customer' ->> 'phone') is null), 'designer does not get the customer phone');
select t.throws($$select staff_job_activity((select j4 from j))$$, 'job_not_found');
select t.throws($$select transition_job((select j4 from j), 'under_review', 'x', null)$$, 'job_not_found');
select t.throws($$select add_job_note((select j4 from j), 'peeking')$$, 'job_not_found');
select t.ok((select active from staff_overview((select org from j))) = (select designer_jobs from exp), 'designer overview counts only her jobs');
reset role;

select t.login(t.u(6));  -- operator
set role authenticated;
select t.ok((select count(*) from jobs) = 1 and (select job_ref from jobs) = 'JOB-2026-0002', 'operator sees only JOB-2026-0002');
select t.throws($$select transition_job((select j4 from j), 'under_review', 'x', null)$$, 'job_not_found');
reset role;

select t.login(t.u(7));  -- accountant
set role authenticated;
select t.ok((select count(*) from jobs) = (select nondraft from exp), 'accountant sees every submitted job');
select t.ok((select count(*) from jobs where status = 'draft') = 0, 'staff never see client drafts');
select t.ok((select count(*) from customers) >= 2, 'accountant can read customers');
select t.throws($$select transition_job((select j4 from j), 'under_review', 'x', null)$$, 'forbidden');
select t.throws($$select set_estimated_completion((select j4 from j), current_date + 3)$$, 'forbidden');
select t.throws($$select assign_job((select j4 from j), t.u(5), 'designer')$$, 'forbidden');
reset role;

select t.login(t.u(3));  -- client Ama
set role authenticated;
select t.ok((select count(*) from job_notes) = 0, 'client sees no staff notes');
select t.ok((select count(*) from job_controls) = 0, 'client sees no staff controls');
select t.ok((select count(*) from job_assignments) = 0, 'client sees no assignments');
select t.ok((select count(*) from business_settings) = 0, 'client sees no business settings');
select t.throws('select * from outbox', 'permission denied');
select t.throws($$select claim_outbox(5)$$, 'permission denied');
select t.throws($$select transition_job((select j3 from j), 'under_review', 'x', null)$$, 'job_not_found');
select t.throws($$select assign_job((select j3 from j), t.u(5), 'designer')$$, 'job_not_found');
select t.throws($$select staff_job_activity((select j3 from j))$$, 'job_not_found');
select t.throws($$select job_next_options((select j3 from j))$$, 'job_not_found');
select t.throws($$select add_job_note((select j3 from j), 'hello')$$, 'job_not_found');
select t.throws($$select record_client_approval((select j3 from j), 'I approve myself')$$, 'job_not_found');
select t.throws($$select set_estimated_completion((select j3 from j), current_date + 1)$$, 'job_not_found');
select t.throws($$select staff_list_jobs((select org from j))$$, 'forbidden');
select t.throws($$select staff_overview((select org from j))$$, 'forbidden');
select t.throws($$select list_assignable_staff((select org from j))$$, 'forbidden');
select t.throws($$select set_business_setting((select org from j), 'enforce_payment_gate', 'false')$$, 'forbidden');
reset role;

set role anon;
select t.throws($$select transition_job((select j3 from j), 'under_review', 'x', null)$$, 'permission denied');
select t.throws($$select staff_list_jobs((select org from j))$$, 'permission denied');
reset role;

-- =================================================================== another business
select t.login(t.u(91));
set role authenticated;
select t.ok((select count(*) from jobs) = 0, 'a manager of another business sees none of our jobs');
select t.throws($$select staff_list_jobs((select org from j))$$, 'forbidden');
select t.throws($$select staff_overview((select org from j))$$, 'forbidden');
select t.throws($$select list_assignable_staff((select org from j))$$, 'forbidden');
select t.throws($$select transition_job((select j4 from j), 'under_review', 'x', null)$$, 'job_not_found');
select t.throws($$select assign_job((select j4 from j), t.u(91), 'worker')$$, 'job_not_found');
select t.throws($$select set_business_setting((select org from j), 'enforce_payment_gate', 'false')$$, 'forbidden');
select t.ok((select count(*) from staff_list_jobs((select id from organisations where slug = 'second-press'))) = 0, 'their own business has no jobs yet');
reset role;

-- =================================================================== assignment
select t.login(t.u(2));  -- manager
set role authenticated;
select t.ok((select count(*) from jobs) = (select nondraft from exp), 'manager sees every submitted job');
select t.ok((select count(*) from list_assignable_staff((select org from j))) = 6, 'six staff can be assigned work');
select t.ok((select count(*) from list_assignable_staff((select org from j)) where role_key = 'client') = 0, 'clients are never offered as assignees');
select t.throws($$select assign_job((select j4 from j), t.u(3), 'worker')$$, 'not_staff_member');
select t.throws($$select assign_job((select j4 from j), gen_random_uuid(), 'worker')$$, 'not_staff_member');
select t.throws($$select assign_job((select j4 from j), t.u(91), 'worker')$$, 'not_staff_member');
select t.throws($$select assign_job((select j4 from j), t.u(5), 'boss')$$, 'invalid_role');
create temp table asg (id uuid);
grant all on asg to authenticated;
insert into asg select assign_job((select j4 from j), t.u(5), 'designer');
select t.ok((select count(*) from job_assignments where job_id = (select j4 from j)) = 1, 'designer assigned to JOB-2026-0004');
select t.ok((select assign_job((select j4 from j), t.u(5), 'designer')) = (select id from asg), 'assigning twice is harmless');
select t.ok((select count(*) from job_assignments where job_id = (select j4 from j)) = 1, 'still one assignment');
select assign_job((select j4 from j), t.u(6), 'operator');
select t.ok((select count(*) from job_assignments where job_id = (select j4 from j)) = 2, 'operator assigned too');
reset role;

select t.ok((select count(*) from notifications where user_id = t.u(5) and type = 'job_assigned') = 1, 'designer was told about the assignment once');

select t.login(t.u(5));
set role authenticated;
select t.ok((select count(*) from jobs) = 2, 'designer now sees her second job');
select t.throws($$select assign_job((select j4 from j), t.u(7), 'worker')$$, 'forbidden');
reset role;

select t.login(t.u(8));  -- customer service
set role authenticated;
select t.throws($$select assign_job((select j4 from j), t.u(7), 'worker')$$, 'forbidden');
select t.throws($$select list_assignable_staff((select org from j))$$, 'forbidden');
reset role;

select t.login(t.u(2));
set role authenticated;
select unassign_job((select j4 from j), t.u(5));
select t.throws($$select unassign_job((select j4 from j), t.u(5))$$, 'not_assigned');
select t.ok((select count(*) from audit_logs where action in ('job.assigned', 'job.unassigned')) >= 3, 'assignments are audited');
reset role;

select t.login(t.u(5));
set role authenticated;
select t.ok((select count(*) from jobs) = 1, 'unassigned designer loses access');
reset role;

-- =================================================================== workflow: JOB-2026-0004
select t.login(t.u(8));  -- customer service
set role authenticated;
select transition_job((select j4 from j), 'under_review', 'We are checking your artwork.', null);
select t.ok((select status from jobs where id = (select j4 from j)) = 'under_review', 'status moved to Under Review');
select t.throws($$select transition_job((select j4 from j), 'under_review', 'again', null)$$, 'same_status');
select t.throws($$select transition_job((select j4 from j), 'nonsense', 'x', null)$$, 'unknown_stage');
select t.throws($$select transition_job((select j4 from j), 'draft', 'x', null)$$, 'draft_not_allowed');
select t.throws($$select transition_job((select j4 from j), 'in_production', 'x', null)$$, 'payment_required');
select t.throws($$select transition_job((select j4 from j), 'queued_for_production', 'x', null)$$, 'payment_required');
select t.throws($$select transition_job((select j4 from j), 'payment_confirmed', 'x', 'cash')$$, 'restricted_stage');
select t.throws($$select transition_job((select j4 from j), 'completed', 'x', null)$$, 'restricted_stage');
select t.throws($$select transition_job((select j4 from j), 'cancelled', 'x', null)$$, 'restricted_stage');
select t.throws($$select transition_job((select j4 from j), 'in_production', repeat('x', 1001), null)$$, 'note_too_long');
reset role;

select t.ok((select count(*) from job_status_history where job_id = (select j4 from j) and to_status = 'under_review' and client_note = 'We are checking your artwork.' and changed_by = t.u(8)) = 1, 'history recorded who moved it and the client note');
select t.ok((select count(*) from audit_logs where action = 'job.status_changed' and entity_id = (select j4 from j)) = 1, 'status change audited');
select t.ok((select count(*) from notifications where user_id = t.u(4) and title = 'JOB-2026-0004: Under Review' and body = 'We are checking your artwork.') = 1, 'client got an in-app alert with the note');
select t.ok((select count(*) from outbox where to_email = 'client2@demo.test' and template = 'job_status' and payload ->> 'status_label' = 'Under Review' and payload ->> 'note' = 'We are checking your artwork.') = 1, 'client email queued');

select t.login(t.u(4));  -- Kofi
set role authenticated;
select t.ok((select count(*) from client_job_timeline where job_id = (select j4 from j) and to_status = 'under_review') = 1, 'client sees the new step on the timeline');
select t.ok((select count(*) from job_status_history) = 0, 'client still cannot read raw history');
reset role;

select t.login(t.u(2));  -- manager confirms payment by hand
set role authenticated;
select t.throws($$select transition_job((select j4 from j), 'payment_confirmed', 'Payment received', null)$$, 'payment_note_required');
select t.throws($$select transition_job((select j4 from j), 'payment_confirmed', 'Payment received', 'ab')$$, 'payment_note_required');
select transition_job((select j4 from j), 'payment_confirmed', 'Payment received, thank you.', 'Cash received, receipt 118');
select t.ok((select payment_cleared_at is not null from job_controls where job_id = (select j4 from j)), 'payment clearance recorded');
select t.ok((select payment_note from job_controls where job_id = (select j4 from j)) = 'Cash received, receipt 118', 'with who confirmed it and why');
reset role;

select t.login(t.u(8));
set role authenticated;
select transition_job((select j4 from j), 'in_production', 'Printing has started.', null);
select t.ok((select status from jobs where id = (select j4 from j)) = 'in_production', 'paid jobs can enter production');
reset role;

select t.login(t.u(6));  -- operator
set role authenticated;
select transition_job((select j4 from j), 'quality_check', null, 'Colour matches the proof');
select t.throws($$select transition_job((select j4 from j), 'cancelled', 'Changed my mind', null)$$, 'restricted_stage');
select t.throws($$select transition_job((select j4 from j), 'completed', 'x', null)$$, 'restricted_stage');
select t.throws($$select transition_job((select j4 from j), 'payment_confirmed', 'x', 'trying it on')$$, 'restricted_stage');
reset role;
select t.ok((select count(*) from notifications where user_id = t.u(4) and title = 'JOB-2026-0004: Quality Check' and body like 'Your job%') = 1, 'default alert text is used when staff add no note');

select t.login(t.u(2));
set role authenticated;
select t.throws($$select transition_job((select j4 from j), 'on_hold', null, 'internal only')$$, 'reason_required');
select transition_job((select j4 from j), 'on_hold', 'Waiting for the new logo file.', null);
select t.ok((select status from jobs where id = (select j4 from j)) = 'on_hold', 'job put on hold with a reason');
select transition_job((select j4 from j), 'in_production', 'Logo received. Printing continues.', null);
select transition_job((select j4 from j), 'cancelled', 'Cancelled at your request.', null);
reset role;

select t.login(t.u(8));
set role authenticated;
select t.throws($$select transition_job((select j4 from j), 'under_review', 'x', null)$$, 'reopen_forbidden');
reset role;

select t.login(t.u(2));
set role authenticated;
select transition_job((select j4 from j), 'under_review', 'Reopened. We are reviewing again.', 'Client changed their mind back');
select t.ok((select status from jobs where id = (select j4 from j)) = 'under_review', 'a manager can reopen a cancelled job');
reset role;

select t.login(t.u(8));
set role authenticated;
select transition_job((select j4 from j), 'in_production', 'Back in production.', null);
select t.ok((select status from jobs where id = (select j4 from j)) = 'in_production', 'payment clearance survives a cancel and reopen');
reset role;

-- =================================================================== approval gate: JOB-2026-0003
select t.login(t.u(8));
set role authenticated;
select t.ok((select status from jobs where id = (select j3 from j)) = 'awaiting_client_approval', 'JOB-2026-0003 waits for the client');
select t.throws($$select transition_job((select j3 from j), 'awaiting_payment', 'x', null)$$, 'approval_required');
select t.throws($$select record_client_approval((select j3 from j), 'ok')$$, 'approval_note_required');
select t.throws($$select record_client_approval((select j4 from j), 'Approved by phone')$$, 'not_awaiting_approval');
select transition_job((select j3 from j), 'under_review', 'Sending you a revised proof.', null);
select transition_job((select j3 from j), 'awaiting_client_approval', 'Please confirm the new proof.', null);
select t.throws($$select transition_job((select j3 from j), 'awaiting_payment', 'x', null)$$, 'approval_required');
select record_client_approval((select j3 from j), 'Approved by phone, 28 Oct, Ama Mensah');
select t.throws($$select record_client_approval((select j3 from j), 'Approved by phone again')$$, 'already_approved');
select transition_job((select j3 from j), 'awaiting_payment', 'Approved. Please pay the deposit.', null);
select t.ok((select status from jobs where id = (select j3 from j)) = 'awaiting_payment', 'recorded approval unlocks the next stage');
select t.ok((select (staff_job_activity((select j3 from j)) -> 'controls' ->> 'approval_note')) = 'Approved by phone, 28 Oct, Ama Mensah', 'staff see how it was approved');
reset role;

select t.login(t.u(3));
set role authenticated;
select t.ok((select count(*) from job_controls) = 0, 'client cannot see approval notes');
reset role;

-- =================================================================== payment gate setting
select t.login(t.u(2));
set role authenticated;
select t.throws($$select set_business_setting((select org from j), 'enforce_payment_gate', 'false')$$, 'forbidden');
reset role;

select t.login(t.u(1));  -- super admin
set role authenticated;
select t.throws($$select set_business_setting((select org from j), 'something_else', 'true')$$, 'invalid_setting');
select t.throws($$select set_business_setting((select org from j), 'enforce_payment_gate', '"yes"')$$, 'invalid_value');
select set_business_setting((select org from j), 'enforce_payment_gate', 'false');
select t.ok((select value from business_settings where key = 'enforce_payment_gate') = 'false'::jsonb, 'admin can switch the payment gate off');
select t.ok((select count(*) from audit_logs where action = 'setting.changed') = 1, 'setting change audited');
reset role;

select t.login(t.u(8));
set role authenticated;
select transition_job((select j3 from j), 'queued_for_production', 'Credit customer: starting now.', null);
select t.ok((select status from jobs where id = (select j3 from j)) = 'queued_for_production', 'with the gate off, unpaid jobs can start');
reset role;

select t.login(t.u(1));
set role authenticated;
select set_business_setting((select org from j), 'enforce_payment_gate', 'true');
reset role;

select t.login(t.u(8));
set role authenticated;
select t.throws($$select transition_job((select j3 from j), 'in_production', 'x', null)$$, 'payment_required');
reset role;

-- =================================================================== estimates
select t.login(t.u(8));
set role authenticated;
select t.throws($$select set_estimated_completion((select j3 from j), current_date - 1)$$, 'date_in_past');
select set_estimated_completion((select j3 from j), current_date + 5);
reset role;

select t.login(t.u(3));
set role authenticated;
select t.ok((select estimated_completion from jobs where id = (select j3 from j)) = current_date + 5, 'client sees the estimated completion date');
select t.ok((select count(*) from notifications where type = 'job_estimate') = 1, 'client was told about the estimate');
reset role;

select t.login(t.u(8));
set role authenticated;
select set_estimated_completion((select j3 from j), null);
select t.ok((select estimated_completion is null from jobs where id = (select j3 from j)), 'estimate can be cleared');
reset role;

-- =================================================================== internal notes
select t.login(t.u(6));
set role authenticated;
select t.throws($$select add_job_note((select j4 from j), '   ')$$, 'invalid_note');
select t.throws($$select add_job_note((select j4 from j), repeat('n', 2001))$$, 'invalid_note');
select add_job_note((select j4 from j), 'Sheets cut, waiting for lamination film');
select t.ok((select count(*) from job_notes) = 1, 'operator sees the note she wrote');
select t.ok((select (staff_job_activity((select j4 from j)) -> 'customer' ->> 'email') is null), 'operator does not get the customer email');
reset role;

select t.login(t.u(5));
set role authenticated;
select t.throws($$select add_job_note((select j4 from j), 'not my job')$$, 'job_not_found');
select t.ok((select count(*) from job_notes) = 0, 'unassigned staff cannot read notes');
reset role;

select t.login(t.u(8));
set role authenticated;
select t.ok((select count(*) from job_notes) = 1, 'customer service sees the note');
select t.ok((select (staff_job_activity((select j4 from j)) -> 'customer' ->> 'email')) = 'client2@demo.test', 'customer service sees the customer email');
select t.ok((select jsonb_array_length(staff_job_activity((select j4 from j)) -> 'history')) >= 9, 'staff see the whole history');
select t.ok((select (staff_job_activity((select j4 from j)) -> 'history' -> 0 ->> 'actor_name')) <> '', 'history shows who made each change');
select t.ok((select count(*) from jsonb_array_elements(staff_job_activity((select j4 from j)) -> 'history') h where h ->> 'internal_note' = 'Cash received, receipt 118') = 1, 'internal notes are visible to staff');
select t.ok((select jsonb_array_length(staff_job_activity((select j4 from j)) -> 'assignees')) = 1, 'assignees are listed');
reset role;

select t.login(t.u(4));
set role authenticated;
select t.ok((select count(*) from job_notes) = 0, 'client cannot read internal notes');
select t.ok((select count(*) from client_job_timeline c where exists (select 1 from jsonb_each_text(to_jsonb(c)) kv where kv.value like '%Cash received%')) = 0, 'client timeline never leaks internal notes');
reset role;
select t.throws($$update job_notes set body = 'edited'$$, 'append-only');
select t.throws($$delete from job_notes$$, 'append-only');

-- =================================================================== finished files
select t.login(t.u(6));
set role authenticated;
insert into job_files (org_id, job_id, storage_path, filename, mime_type, size_bytes, kind, uploaded_by)
values ((select org from j), (select j4 from j), (select org from j)::text || '/' || (select j4 from j)::text || '/final.pdf', 'final.pdf', 'application/pdf', 2048, 'deliverable', t.u(6));
select t.ok((select count(*) from job_files where kind = 'deliverable') = 1, 'operator attached a finished file');
select t.throws($$insert into job_files (org_id, job_id, storage_path, filename, size_bytes, kind, uploaded_by) values ((select org from j), (select j3 from j), 'x/y/z.pdf', 'z.pdf', 10, 'deliverable', t.u(6))$$, 'row-level security');
insert into storage.objects (bucket_id, name, owner) values ('job-files', (select org from j)::text || '/' || (select j4 from j)::text || '/final.pdf', t.u(6));
select t.ok((select count(*) from storage.objects) = 1, 'operator uploaded the finished file to storage');
select t.throws($$insert into storage.objects (bucket_id, name, owner) values ('job-files', (select org from j)::text || '/' || (select j3 from j)::text || '/other.pdf', t.u(6))$$, 'row-level security');
select t.throws($$insert into storage.objects (bucket_id, name, owner) values ('job-files', (select org from j)::text || '/' || (select j4 from j)::text || '/tool.exe', t.u(6))$$, 'row-level security');
reset role;

select t.login(t.u(5));  -- designer, no longer assigned
set role authenticated;
select t.throws($$insert into storage.objects (bucket_id, name, owner) values ('job-files', (select org from j)::text || '/' || (select j4 from j)::text || '/sneak.pdf', t.u(5))$$, 'row-level security');
select t.ok((select count(*) from storage.objects) = 0, 'unassigned staff cannot read job files');
reset role;

select t.login(t.u(4));  -- the client
set role authenticated;
select t.ok((select count(*) from job_files where kind = 'deliverable') = 1, 'client sees the finished file');
select t.ok((select count(*) from storage.objects) = 1, 'client can download the finished file');
with d as (delete from job_files where kind = 'deliverable' returning 1)
select t.ok((select count(*) from d) = 0, 'client cannot delete a finished file');
reset role;

select t.login(t.u(6));
set role authenticated;
with d as (delete from job_files where kind = 'deliverable' returning 1)
select t.ok((select count(*) from d) = 1, 'staff can remove a finished file they uploaded by mistake');
delete from storage.objects where bucket_id = 'job-files';
select t.ok((select count(*) from storage.objects) = 0, 'and its stored copy');
reset role;

-- =================================================================== email preferences
select t.login(t.u(4));  -- Kofi turns email off
set role authenticated;
insert into notification_preferences (user_id, email_enabled) values (t.u(4), false);
select t.throws($$insert into notification_preferences (user_id, email_enabled) values (t.u(3), false)$$, 'row-level security');
reset role;

select t.login(t.u(3));
set role authenticated;
with u as (update notification_preferences set email_enabled = true returning 1)
select t.ok((select count(*) from u) = 0, 'a client cannot change someone else''s email preference');
reset role;

select t.login(t.u(2));
set role authenticated;
select transition_job((select j4 from j), 'quality_check', 'Final checks under way.', null);
reset role;
select t.ok((select count(*) from notifications where user_id = t.u(4) and title = 'JOB-2026-0004: Quality Check' and body = 'Final checks under way.') = 1, 'in-app alert still sent when email is off');
select t.ok((select count(*) from outbox where to_email = 'client2@demo.test' and payload ->> 'note' = 'Final checks under way.') = 0, 'no email queued when the client turned email off');

select t.login(t.u(4));
set role authenticated;
update notification_preferences set email_enabled = true;
reset role;

select t.login(t.u(2));
set role authenticated;
select transition_job((select j4 from j), 'ready_for_collection', 'Ready. Please bring your job number.', null);
reset role;
select t.ok((select count(*) from outbox where to_email = 'client2@demo.test' and payload ->> 'note' = 'Ready. Please bring your job number.') = 1, 'email queued again once switched back on');

-- the same event can never produce two alerts or two emails
select enqueue_notice((select org from j), t.u(4), 'test', 'Dup', 'body', '/portal/dashboard', 'test:dup-1', 'job_status', '{"job_ref":"X"}'::jsonb);
select enqueue_notice((select org from j), t.u(4), 'test', 'Dup', 'body', '/portal/dashboard', 'test:dup-1', 'job_status', '{"job_ref":"X"}'::jsonb);
select t.ok((select count(*) from notifications where dedupe_key = 'test:dup-1') = 1, 'duplicate event: one in-app alert');
select t.ok((select count(*) from outbox where dedupe_key = 'test:dup-1') = 1, 'duplicate event: one email');

-- new submissions alert staff who triage, and nobody else
select t.ok((select count(*) from notifications where type = 'job_received' and user_id = t.u(2)) >= 1, 'manager was alerted to a new job');
select t.ok((select count(*) from notifications where type = 'job_received' and user_id in (t.u(5), t.u(6), t.u(7))) = 0, 'designer, operator and accountant were not');

-- =================================================================== options shown on screen match the rules
select t.login(t.u(6));
set role authenticated;
select t.ok((select allowed from job_next_options((select j4 from j)) where status_key = 'in_production'), 'operator may move the job back into production');
select t.ok((select reason from job_next_options((select j4 from j)) where status_key = 'cancelled') = 'restricted_stage', 'cancelling is shown as restricted');
select t.ok((select reason from job_next_options((select j4 from j)) where status_key = 'payment_confirmed') = 'restricted_stage', 'confirming payment is shown as restricted');
select t.ok((select count(*) from job_next_options((select j4 from j)) where status_key in ('draft', 'ready_for_collection')) = 0, 'draft and the current stage are never offered');
reset role;

select t.login(t.u(8));
set role authenticated;
select t.ok((select reason from job_next_options((select j3 from j)) where status_key = 'in_production') = 'payment_required', 'unpaid job shows production as blocked');
reset role;

-- =================================================================== dashboard numbers
create temp table exp2 as
select
  count(*) filter (where j.submitted_at >= date_trunc('day', now())) as received_today,
  count(*) filter (where not s.is_terminal) as active,
  count(*) filter (where j.due_date < current_date and not s.is_terminal and j.status not in ('ready_for_collection', 'out_for_delivery')) as overdue,
  count(*) filter (where j.status = 'awaiting_client_approval') as awaiting_approval,
  count(*) filter (where j.status = 'awaiting_payment') as awaiting_payment,
  count(*) filter (where j.status in ('ready_for_collection', 'out_for_delivery')) as ready
from jobs j join workflow_stages s on s.workflow_id = j.workflow_id and s.status_key = j.status
where j.org_id = (select org from j) and j.status <> 'draft';
grant select on exp2 to authenticated;

select t.login(t.u(2));
set role authenticated;
select t.ok((select (o.received_today, o.active, o.overdue, o.awaiting_approval, o.awaiting_payment, o.ready) = (e.received_today, e.active, e.overdue, e.awaiting_approval, e.awaiting_payment, e.ready)
             from staff_overview((select org from j)) o, exp2 e), 'manager overview matches the data');
select t.ok((select count(*) from staff_list_jobs((select org from j), null, 'kofi')) >= 1, 'search finds jobs by customer name');
select t.ok((select count(*) from staff_list_jobs((select org from j), null, 'JOB-2026-0004')) = 1, 'search finds jobs by reference');
select t.ok((select count(*) from staff_list_jobs((select org from j), null, '%')) = 0, 'a % in the search box is not a wildcard');
select t.ok((select count(*) from staff_list_jobs((select org from j), array['ready_for_collection'])) = 1, 'status filter works');
select t.ok((select count(*) from staff_list_jobs((select org from j), null, null, t.u(6))) = 2, 'assignee filter works');
select t.ok((select count(*) from staff_list_jobs((select org from j), null, null, null, false, 2, 0)) = 2 and (select max(total_count) from staff_list_jobs((select org from j), null, null, null, false, 2, 0)) = (select nondraft from exp), 'paging returns a page and the total');
reset role;

-- =================================================================== email queue (server side)
update outbox set status = 'sent';  -- clear the queue so only the rows below are in play
insert into outbox (org_id, to_email, template, payload, dedupe_key) values
  ((select org from j), 'a@test.dev', 'job_status', '{}', 'test:a'),
  ((select org from j), 'b@test.dev', 'job_status', '{}', 'test:b'),
  ((select org from j), 'c@test.dev', 'job_status', '{}', 'test:c');

set role service_role;
select t.ok((select count(*) from claim_outbox(2)) = 2, 'worker claims up to the batch size');
select t.ok((select count(*) from claim_outbox(10)) = 1, 'the next worker gets only the unclaimed one');
select t.ok((select count(*) from claim_outbox(10)) = 0, 'nothing is handed out twice');
reset role;
select t.ok((select count(*) from outbox where dedupe_key like 'test:%' and status = 'sending' and attempts = 1) = 3, 'claimed rows are marked sending with one attempt');

select mark_outbox_sent((select id from outbox where dedupe_key = 'test:a'));
select mark_outbox_failed((select id from outbox where dedupe_key = 'test:b'), 'Resend 422: invalid address');
select t.ok((select status from outbox where dedupe_key = 'test:a') = 'sent' and (select sent_at is not null from outbox where dedupe_key = 'test:a'), 'sent rows are closed');
select t.ok((select status = 'retry' and next_attempt_at > now() and last_error like 'Resend 422%' from outbox where dedupe_key = 'test:b'), 'failed rows retry later and keep the reason');
select mark_outbox_sent((select id from outbox where dedupe_key = 'test:b'));
select t.ok((select status from outbox where dedupe_key = 'test:b') = 'retry', 'a row that is not being sent cannot be marked sent');

set role service_role;
select t.ok((select count(*) from claim_outbox(10)) = 0, 'a retry waits for its time');
reset role;
update outbox set next_attempt_at = now() where dedupe_key = 'test:b';
set role service_role;
select t.ok((select attempts from claim_outbox(10)) = 2, 'then it is claimed again with a higher attempt count');
reset role;

do $$
begin
  for i in 3..5 loop
    perform mark_outbox_failed((select id from outbox where dedupe_key = 'test:b'), 'still failing');
    update outbox set next_attempt_at = now() where dedupe_key = 'test:b' and status = 'retry';
    perform * from claim_outbox(10);
  end loop;
  perform mark_outbox_failed((select id from outbox where dedupe_key = 'test:b'), 'giving up');
end $$;
select t.ok((select status from outbox where dedupe_key = 'test:b') = 'failed', 'after five attempts the email is parked as failed');
set role service_role;
select t.ok((select count(*) from claim_outbox(10)) = 0, 'failed emails are not retried forever');
reset role;

update outbox set locked_at = now() - interval '11 minutes' where dedupe_key = 'test:c';
set role service_role;
select t.ok((select count(*) from claim_outbox(10)) = 1, 'a row stuck in sending after a crash is picked up again');
reset role;
select t.ok((select attempts from outbox where dedupe_key = 'test:c') = 2, 'and counted');

update outbox set locked_at = now() - interval '11 minutes', attempts = 5 where dedupe_key = 'test:c';
set role service_role;
select t.ok((select count(*) from claim_outbox(10)) = 0, 'a crashed row on its last attempt is not claimed');
reset role;
select t.ok((select status from outbox where dedupe_key = 'test:c') = 'failed', 'it is parked as failed instead');

set role anon;
select t.throws($$select claim_outbox(5)$$, 'permission denied');
reset role;
select t.login(t.u(1));
set role authenticated;
select t.throws($$select claim_outbox(5)$$, 'permission denied');
select t.throws($$select mark_outbox_sent(gen_random_uuid())$$, 'permission denied');
select t.throws('select count(*) from outbox', 'permission denied');
reset role;

\echo
\echo ALL STAFF CHECKS PASSED
