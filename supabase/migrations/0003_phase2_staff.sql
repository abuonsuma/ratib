-- Ratib Phase 2: staff side.
--   * Staff visibility: managers/customer service/accountants see every job; designers, operators and delivery staff see only jobs assigned to them.
--   * Job assignment, internal notes, estimated completion, recorded client approval.
--   * The workflow engine: transition_job() is the ONLY way a job changes stage. It checks permission, restricted stages,
--     approval and payment gates, and writes history, audit, in-app notification and an email job in one transaction.
--   * Email outbox (queue) with safe claiming, retries and de-duplication, plus per-user email preference.
--   * Business settings (payment gate on/off).
-- Same rule as before: every new table is revoked from the browser roles and re-granted explicitly at the end of this file.

-- ---------------------------------------------------------------------------
-- permissions
-- ---------------------------------------------------------------------------
insert into permissions (key, description) values
  ('jobs.read_all',    'See every job in the business (without it, only jobs assigned to you)'),
  ('jobs.cancel',      'Cancel a job'),
  ('jobs.complete',    'Mark a job as completed'),
  ('jobs.reopen',      'Reopen a completed or cancelled job'),
  ('payments.confirm', 'Confirm payment by hand (cash, bank transfer, approved credit)')
on conflict do nothing;

alter table workflow_stages add column required_permission text references permissions (key);

-- ---------------------------------------------------------------------------
-- new tables
-- ---------------------------------------------------------------------------
create table job_assignments (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organisations (id) on delete cascade,
  job_id      uuid not null references jobs (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role_on_job text not null default 'worker' check (role_on_job in ('designer', 'operator', 'delivery', 'worker')),
  assigned_by uuid references auth.users (id),
  created_at  timestamptz not null default now(),
  unique (job_id, user_id)
);
create index job_assignments_user_idx on job_assignments (user_id);

-- staff-only facts about a job (kept apart from `jobs`, which clients can read)
create table job_controls (
  job_id             uuid primary key references jobs (id) on delete cascade,
  org_id             uuid not null references organisations (id) on delete cascade,
  payment_cleared_at timestamptz,
  payment_cleared_by uuid references auth.users (id),
  payment_note       text,
  approved_at        timestamptz,
  approved_by        uuid references auth.users (id),
  approval_note      text
);

create table job_notes (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organisations (id) on delete cascade,
  job_id     uuid not null references jobs (id) on delete cascade,
  author_id  uuid not null references auth.users (id),
  body       text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index job_notes_job_idx on job_notes (job_id, created_at);
create trigger job_notes_no_update before update or delete on job_notes
  for each row execute function forbid_change();

create table business_settings (
  org_id     uuid not null references organisations (id) on delete cascade,
  key        text not null,
  value      jsonb not null,
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  primary key (org_id, key)
);

create table notification_preferences (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  email_enabled boolean not null default true,
  updated_at    timestamptz not null default now()
);

create table outbox (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid references organisations (id) on delete cascade,
  user_id         uuid references auth.users (id) on delete set null,
  channel         text not null default 'email' check (channel in ('email')),
  to_email        text not null,
  template        text not null,
  payload         jsonb not null default '{}'::jsonb,
  dedupe_key      text not null unique,
  status          text not null default 'pending' check (status in ('pending', 'sending', 'retry', 'sent', 'failed')),
  attempts        int  not null default 0,
  last_error      text,
  next_attempt_at timestamptz not null default now(),
  locked_at       timestamptz,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);
create index outbox_due_idx on outbox (status, next_attempt_at);

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------
create or replace function org_setting_bool(p_org uuid, p_key text, p_default boolean) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select (value #>> '{}')::boolean from business_settings where org_id = p_org and key = p_key), p_default);
$$;

-- Can the signed-in staff member see this job? Drafts belong to the client and are never visible to staff.
create or replace function can_staff_see_job(p_job uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from jobs j
    where j.id = p_job and j.status <> 'draft'
      and (
        has_perm(j.org_id, 'jobs.read_all')
        or (has_perm(j.org_id, 'jobs.read')
            and exists (select 1 from job_assignments a where a.job_id = j.id and a.user_id = auth.uid()))
      )
  );
$$;

-- one place that writes an in-app notification and (optionally) queues an email, once per dedupe key
create or replace function enqueue_notice(
  p_org uuid, p_user uuid, p_type text, p_title text, p_body text, p_link text,
  p_dedupe text, p_template text, p_payload jsonb
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_email text;
  v_pref  boolean;
begin
  insert into notifications (org_id, user_id, type, title, body, link, dedupe_key)
  values (p_org, p_user, p_type, p_title, p_body, p_link, p_dedupe)
  on conflict do nothing;

  if p_template is null then return; end if;

  select u.email into v_email from auth.users u where u.id = p_user;
  select coalesce((select email_enabled from notification_preferences where user_id = p_user), true) into v_pref;

  if v_email is not null and v_pref then
    insert into outbox (org_id, user_id, to_email, template, payload, dedupe_key)
    values (p_org, p_user, v_email, p_template, coalesce(p_payload, '{}'::jsonb), p_dedupe)
    on conflict (dedupe_key) do nothing;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- default roles and workflow, extended (safe to re-run on existing businesses)
-- ---------------------------------------------------------------------------
create or replace function seed_org_defaults(p_org uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_wf uuid;
  r record;
  v_role uuid;
begin
  insert into roles (org_id, key, name, is_staff) values
    (p_org, 'super_admin',      'Super Administrator',  true),
    (p_org, 'manager',          'Manager',              true),
    (p_org, 'customer_service', 'Customer Service',     true),
    (p_org, 'designer',         'Designer',             true),
    (p_org, 'operator',         'Production Operator',  true),
    (p_org, 'accountant',       'Accountant / Cashier', true),
    (p_org, 'delivery',         'Delivery Staff',       true),
    (p_org, 'client',           'Client',               false)
  on conflict (org_id, key) do nothing;

  for r in
    select * from (values
      ('super_admin','jobs.read'),('super_admin','jobs.read_all'),('super_admin','jobs.update_status'),('super_admin','jobs.assign'),
      ('super_admin','jobs.cancel'),('super_admin','jobs.complete'),('super_admin','jobs.reopen'),('super_admin','customers.read'),
      ('super_admin','catalogue.manage'),('super_admin','staff.manage'),('super_admin','audit.read'),('super_admin','settings.manage'),
      ('super_admin','payments.confirm'),
      ('manager','jobs.read'),('manager','jobs.read_all'),('manager','jobs.update_status'),('manager','jobs.assign'),
      ('manager','jobs.cancel'),('manager','jobs.complete'),('manager','jobs.reopen'),('manager','customers.read'),
      ('manager','catalogue.manage'),('manager','audit.read'),('manager','payments.confirm'),
      ('customer_service','jobs.read'),('customer_service','jobs.read_all'),('customer_service','jobs.update_status'),('customer_service','customers.read'),
      ('designer','jobs.read'),('designer','jobs.update_status'),
      ('operator','jobs.read'),('operator','jobs.update_status'),
      ('accountant','jobs.read'),('accountant','jobs.read_all'),('accountant','customers.read'),('accountant','payments.confirm'),
      ('delivery','jobs.read'),('delivery','jobs.update_status'),('delivery','jobs.complete')
    ) as t(role_key, perm)
  loop
    select id into v_role from roles where org_id = p_org and key = r.role_key;
    insert into role_permissions (role_id, permission_key) values (v_role, r.perm) on conflict do nothing;
  end loop;

  insert into workflows (org_id, name, is_default) values (p_org, 'Standard job workflow', true) on conflict do nothing;
  select id into v_wf from workflows where org_id = p_org and is_default;

  insert into workflow_stages
    (org_id, workflow_id, status_key, label, position, requires_approval, requires_payment, off_track, is_terminal, required_permission)
  values
    (p_org, v_wf, 'draft',                    'Draft',                   1,  false, false, false, false, null),
    (p_org, v_wf, 'submitted',                'Submitted',               2,  false, false, false, false, null),
    (p_org, v_wf, 'under_review',             'Under Review',            3,  false, false, false, false, null),
    (p_org, v_wf, 'awaiting_quotation',       'Awaiting Quotation',      4,  false, false, false, false, null),
    (p_org, v_wf, 'awaiting_client_approval', 'Awaiting Your Approval',  5,  true,  false, false, false, null),
    (p_org, v_wf, 'awaiting_payment',         'Awaiting Payment',        6,  false, false, false, false, null),
    (p_org, v_wf, 'payment_confirmed',        'Payment Confirmed',       7,  false, false, false, false, 'payments.confirm'),
    (p_org, v_wf, 'queued_for_production',    'Queued for Production',   8,  false, true,  false, false, null),
    (p_org, v_wf, 'in_production',            'In Production',           9,  false, true,  false, false, null),
    (p_org, v_wf, 'quality_check',            'Quality Check',           10, false, true,  false, false, null),
    (p_org, v_wf, 'ready_for_collection',     'Ready for Collection',    11, false, true,  false, false, null),
    (p_org, v_wf, 'out_for_delivery',         'Out for Delivery',        12, false, true,  false, false, null),
    (p_org, v_wf, 'completed',                'Completed',               13, false, true,  false, true,  'jobs.complete'),
    (p_org, v_wf, 'on_hold',                  'On Hold',                 98, false, false, true,  false, null),
    (p_org, v_wf, 'cancelled',                'Cancelled',               99, false, false, true,  true,  'jobs.cancel')
  on conflict (workflow_id, status_key) do nothing;

  insert into service_categories (org_id, name, slug, sort_order, workflow_id) values
    (p_org, 'Graphic design',                     'graphic-design',    1, v_wf),
    (p_org, 'Business cards',                     'business-cards',    2, v_wf),
    (p_org, 'Flyers and posters',                 'flyers-posters',    3, v_wf),
    (p_org, 'Banners and signage',                'banners-signage',   4, v_wf),
    (p_org, 'Book printing and binding',          'book-printing',     5, v_wf),
    (p_org, 'Document printing and photocopying', 'document-printing', 6, v_wf),
    (p_org, 'Branding and promotional materials', 'branding-promo',    7, v_wf),
    (p_org, 'Other custom services',              'other',             8, v_wf)
  on conflict (org_id, slug) do nothing;
end $$;

-- bring businesses created in Phase 1 up to date
do $$
declare o record;
begin
  for o in select id from organisations loop
    perform seed_org_defaults(o.id);
  end loop;
  update workflow_stages set required_permission = 'payments.confirm' where status_key = 'payment_confirmed' and required_permission is null;
  update workflow_stages set required_permission = 'jobs.complete'    where status_key = 'completed'         and required_permission is null;
  update workflow_stages set required_permission = 'jobs.cancel'      where status_key = 'cancelled'         and required_permission is null;
end $$;

-- ---------------------------------------------------------------------------
-- Row Level Security for the new tables, and tighter staff access to jobs
-- ---------------------------------------------------------------------------
alter table job_assignments         enable row level security;
alter table job_controls            enable row level security;
alter table job_notes               enable row level security;
alter table business_settings       enable row level security;
alter table notification_preferences enable row level security;
alter table outbox                  enable row level security;

-- (must not reference `jobs`, because the jobs policy below reads this table)
create policy assignments_select on job_assignments for select
  using (user_id = auth.uid() or has_perm(org_id, 'jobs.read_all'));

create policy controls_select on job_controls for select
  using (has_perm(org_id, 'jobs.read') and can_staff_see_job(job_id));

create policy notes_select on job_notes for select
  using (has_perm(org_id, 'jobs.read') and can_staff_see_job(job_id));

create policy settings_select on business_settings for select using (has_perm(org_id, 'settings.manage'));

create policy prefs_select on notification_preferences for select using (user_id = auth.uid());
create policy prefs_insert on notification_preferences for insert with check (user_id = auth.uid());
create policy prefs_update on notification_preferences for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- outbox: no policies at all. Only the server (service role) can touch it.

drop policy jobs_select_staff on jobs;
create policy jobs_select_staff on jobs for select using (
  status <> 'draft'
  and (
    has_perm(org_id, 'jobs.read_all')
    or (has_perm(org_id, 'jobs.read')
        and exists (select 1 from job_assignments a where a.job_id = jobs.id and a.user_id = auth.uid()))
  )
);

drop policy history_select_staff on job_status_history;
create policy history_select_staff on job_status_history for select using (can_staff_see_job(job_id));

-- staff may attach files (finished work) to jobs they can see
drop policy job_files_insert_staff on job_files;
create policy job_files_insert_staff on job_files for insert with check (
  uploaded_by = auth.uid()
  and has_perm(org_id, 'jobs.update_status')
  and exists (select 1 from jobs j where j.id = job_id and j.org_id = job_files.org_id and can_staff_see_job(j.id))
);
create policy job_files_delete_staff on job_files for delete using (
  uploaded_by = auth.uid() and kind = 'deliverable' and has_perm(org_id, 'jobs.update_status')
);

create policy job_files_upload_staff on storage.objects for insert to authenticated
with check (
  bucket_id = 'job-files'
  and job_file_extension_ok(name)
  and exists (
    select 1 from public.jobs j
    where j.id::text = (storage.foldername(name))[2]
      and j.org_id::text = (storage.foldername(name))[1]
      and public.has_perm(j.org_id, 'jobs.update_status')
      and public.can_staff_see_job(j.id)
  )
);
create policy job_files_remove_staff on storage.objects for delete to authenticated
using (bucket_id = 'job-files' and owner = auth.uid() and public.has_perm((storage.foldername(name))[1]::uuid, 'jobs.update_status'));

-- ---------------------------------------------------------------------------
-- the workflow engine
-- ---------------------------------------------------------------------------
-- Returns NULL when the move is allowed, otherwise a short code explaining why not.
-- Used by transition_job() and by job_next_options() so the screen and the rule can never disagree.
create or replace function transition_problem(p_job jobs, p_to text, p_client_note text, p_internal_note text) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  v_from workflow_stages%rowtype;
  v_to   workflow_stages%rowtype;
  v_ctrl job_controls%rowtype;
begin
  if auth.uid() is null then return 'not_authenticated'; end if;
  if not has_perm(p_job.org_id, 'jobs.update_status') or not can_staff_see_job(p_job.id) then return 'forbidden'; end if;
  if p_job.status = 'draft' or p_to = 'draft' then return 'draft_not_allowed'; end if;

  select * into v_to from workflow_stages where workflow_id = p_job.workflow_id and status_key = p_to;
  if not found then return 'unknown_stage'; end if;
  select * into v_from from workflow_stages where workflow_id = p_job.workflow_id and status_key = p_job.status;

  if p_to = p_job.status then return 'same_status'; end if;
  if v_from.is_terminal and not has_perm(p_job.org_id, 'jobs.reopen') then return 'reopen_forbidden'; end if;
  if v_to.required_permission is not null and not has_perm(p_job.org_id, v_to.required_permission) then return 'restricted_stage'; end if;

  select * into v_ctrl from job_controls where job_id = p_job.id;

  if v_from.requires_approval and not v_to.off_track and v_to.position > v_from.position and v_ctrl.approved_at is null then
    return 'approval_required';
  end if;
  if v_to.requires_payment and org_setting_bool(p_job.org_id, 'enforce_payment_gate', true) and v_ctrl.payment_cleared_at is null then
    return 'payment_required';
  end if;
  if v_to.off_track and nullif(trim(coalesce(p_client_note, '')), '') is null then return 'reason_required'; end if;
  if p_to = 'payment_confirmed' and char_length(trim(coalesce(p_internal_note, ''))) < 3 then return 'payment_note_required'; end if;
  return null;
end $$;

create or replace function transition_job(p_job_id uuid, p_to text, p_client_note text default null, p_internal_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_job      jobs%rowtype;
  v_to       workflow_stages%rowtype;
  v_problem  text;
  v_hist     uuid;
  v_cust     customers%rowtype;
  v_org      organisations%rowtype;
  v_client   text := nullif(trim(coalesce(p_client_note, '')), '');
  v_internal text := nullif(trim(coalesce(p_internal_note, '')), '');
  v_from     text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if char_length(coalesce(v_client, '')) > 1000 or char_length(coalesce(v_internal, '')) > 2000 then
    raise exception 'note_too_long';
  end if;

  select * into v_job from jobs where id = p_job_id for update;
  if not found or not can_staff_see_job(p_job_id) then raise exception 'job_not_found'; end if;

  v_problem := transition_problem(v_job, p_to, v_client, v_internal);
  if v_problem is not null then raise exception '%', v_problem; end if;

  select * into v_to from workflow_stages where workflow_id = v_job.workflow_id and status_key = p_to;
  v_from := v_job.status;

  update jobs set status = p_to where id = v_job.id;

  insert into job_status_history (org_id, job_id, from_status, to_status, changed_by, client_note, internal_note)
  values (v_job.org_id, v_job.id, v_from, p_to, auth.uid(), v_client, v_internal)
  returning id into v_hist;

  if p_to = 'payment_confirmed' then
    insert into job_controls (job_id, org_id, payment_cleared_at, payment_cleared_by, payment_note)
    values (v_job.id, v_job.org_id, now(), auth.uid(), v_internal)
    on conflict (job_id) do update
      set payment_cleared_at = now(), payment_cleared_by = auth.uid(), payment_note = v_internal;
  end if;

  insert into audit_logs (org_id, actor_id, action, entity, entity_id, before, after)
  values (v_job.org_id, auth.uid(), 'job.status_changed', 'job', v_job.id,
          jsonb_build_object('status', v_from), jsonb_build_object('status', p_to, 'job_ref', v_job.job_ref));

  if v_to.notify_client and v_to.client_visible then
    select * into v_cust from customers where id = v_job.customer_id;
    select * into v_org  from organisations where id = v_job.org_id;
    if v_cust.user_id is not null then
      perform enqueue_notice(
        v_job.org_id, v_cust.user_id, 'job_status',
        v_job.job_ref || ': ' || v_to.label,
        coalesce(v_client, 'Your job "' || v_job.title || '" is now: ' || v_to.label || '.'),
        '/portal/jobs/' || v_job.id,
        'job:' || v_job.id || ':hist:' || v_hist,
        'job_status',
        jsonb_build_object('org_name', v_org.name, 'job_ref', v_job.job_ref, 'title', v_job.title,
                           'status_label', v_to.label, 'note', v_client, 'link', '/portal/jobs/' || v_job.id));
    end if;
  end if;
end $$;

-- staff record that the client approved by phone, WhatsApp or in person (until online approval arrives with quotations)
create or replace function record_client_approval(p_job_id uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_job  jobs%rowtype;
  v_note text := trim(coalesce(p_note, ''));
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into v_job from jobs where id = p_job_id for update;
  if not found or not can_staff_see_job(p_job_id) then raise exception 'job_not_found'; end if;
  if not has_perm(v_job.org_id, 'jobs.update_status') then raise exception 'forbidden'; end if;
  if not exists (select 1 from workflow_stages where workflow_id = v_job.workflow_id and status_key = v_job.status and requires_approval) then
    raise exception 'not_awaiting_approval';
  end if;
  if char_length(v_note) < 3 then raise exception 'approval_note_required'; end if;
  if exists (select 1 from job_controls where job_id = v_job.id and approved_at is not null) then raise exception 'already_approved'; end if;

  insert into job_controls (job_id, org_id, approved_at, approved_by, approval_note)
  values (v_job.id, v_job.org_id, now(), auth.uid(), left(v_note, 500))
  on conflict (job_id) do update set approved_at = now(), approved_by = auth.uid(), approval_note = left(v_note, 500);

  insert into audit_logs (org_id, actor_id, action, entity, entity_id, after)
  values (v_job.org_id, auth.uid(), 'job.approval_recorded', 'job', v_job.id, jsonb_build_object('note', left(v_note, 500)));
end $$;

create or replace function set_estimated_completion(p_job_id uuid, p_date date) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_job  jobs%rowtype;
  v_cust customers%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into v_job from jobs where id = p_job_id for update;
  if not found or not can_staff_see_job(p_job_id) then raise exception 'job_not_found'; end if;
  if not has_perm(v_job.org_id, 'jobs.update_status') then raise exception 'forbidden'; end if;
  if p_date is not null and p_date < current_date then raise exception 'date_in_past'; end if;

  update jobs set estimated_completion = p_date where id = v_job.id;
  insert into audit_logs (org_id, actor_id, action, entity, entity_id, before, after)
  values (v_job.org_id, auth.uid(), 'job.estimate_changed', 'job', v_job.id,
          jsonb_build_object('estimated_completion', v_job.estimated_completion), jsonb_build_object('estimated_completion', p_date));

  if p_date is not null then
    select * into v_cust from customers where id = v_job.customer_id;
    if v_cust.user_id is not null then
      perform enqueue_notice(v_job.org_id, v_cust.user_id, 'job_estimate', v_job.job_ref || ': estimated completion',
        'We expect "' || v_job.title || '" to be done by ' || to_char(p_date, 'DD Mon YYYY') || '.',
        '/portal/jobs/' || v_job.id, 'job:' || v_job.id || ':eta:' || p_date, null, null);
    end if;
  end if;
end $$;

create or replace function add_job_note(p_job_id uuid, p_body text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_job  jobs%rowtype;
  v_body text := trim(coalesce(p_body, ''));
  v_id   uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into v_job from jobs where id = p_job_id;
  if not found or not can_staff_see_job(p_job_id) then raise exception 'job_not_found'; end if;
  if not has_perm(v_job.org_id, 'jobs.read') then raise exception 'forbidden'; end if;
  if char_length(v_body) < 1 or char_length(v_body) > 2000 then raise exception 'invalid_note'; end if;
  insert into job_notes (org_id, job_id, author_id, body) values (v_job.org_id, v_job.id, auth.uid(), v_body) returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- assignment
-- ---------------------------------------------------------------------------
create or replace function assign_job(p_job_id uuid, p_user_id uuid, p_role text default 'worker') returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_id  uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into v_job from jobs where id = p_job_id for update;
  if not found or not can_staff_see_job(p_job_id) then raise exception 'job_not_found'; end if;
  if not has_perm(v_job.org_id, 'jobs.assign') then raise exception 'forbidden'; end if;
  if p_role not in ('designer', 'operator', 'delivery', 'worker') then raise exception 'invalid_role'; end if;
  if not exists (
    select 1 from org_members m join roles r on r.id = m.role_id
    where m.org_id = v_job.org_id and m.user_id = p_user_id and m.status = 'active' and r.is_staff
  ) then
    raise exception 'not_staff_member';
  end if;

  insert into job_assignments (org_id, job_id, user_id, role_on_job, assigned_by)
  values (v_job.org_id, v_job.id, p_user_id, p_role, auth.uid())
  on conflict (job_id, user_id) do update set role_on_job = excluded.role_on_job
  returning id into v_id;

  insert into audit_logs (org_id, actor_id, action, entity, entity_id, after)
  values (v_job.org_id, auth.uid(), 'job.assigned', 'job', v_job.id, jsonb_build_object('user_id', p_user_id, 'role', p_role));

  if p_user_id <> auth.uid() then
    perform enqueue_notice(v_job.org_id, p_user_id, 'job_assigned', 'Assigned to you: ' || v_job.job_ref,
      v_job.title, '/admin/jobs/' || v_job.id, 'job:' || v_job.id || ':assigned:' || v_id, null, null);
  end if;
  return v_id;
end $$;

create or replace function unassign_job(p_job_id uuid, p_user_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_job jobs%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into v_job from jobs where id = p_job_id for update;
  if not found or not can_staff_see_job(p_job_id) then raise exception 'job_not_found'; end if;
  if not has_perm(v_job.org_id, 'jobs.assign') then raise exception 'forbidden'; end if;
  delete from job_assignments where job_id = v_job.id and user_id = p_user_id;
  if not found then raise exception 'not_assigned'; end if;
  insert into audit_logs (org_id, actor_id, action, entity, entity_id, before)
  values (v_job.org_id, auth.uid(), 'job.unassigned', 'job', v_job.id, jsonb_build_object('user_id', p_user_id));
end $$;

create or replace function list_assignable_staff(p_org uuid)
returns table (user_id uuid, full_name text, role_key text, role_name text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if auth.uid() is null or not has_perm(p_org, 'jobs.assign') then raise exception 'forbidden'; end if;
  return query
  select m.user_id, coalesce(p.full_name, ''), r.key, r.name
  from org_members m
  join roles r on r.id = m.role_id
  left join profiles p on p.user_id = m.user_id
  where m.org_id = p_org and m.status = 'active' and r.is_staff
  order by coalesce(p.full_name, ''), r.name;
end $$;

-- ---------------------------------------------------------------------------
-- staff screens
-- ---------------------------------------------------------------------------
create or replace function staff_list_jobs(
  p_org uuid, p_status text[] default null, p_q text default null, p_assignee uuid default null,
  p_overdue boolean default false, p_limit int default 25, p_offset int default 0
) returns table (
  id uuid, job_ref text, title text, status text, status_label text, priority text, due_date date,
  estimated_completion date, submitted_at timestamptz, customer_name text, company_name text,
  assignees text, is_overdue boolean, total_count bigint
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_pat text;
begin
  if auth.uid() is null or not has_perm(p_org, 'jobs.read') then raise exception 'forbidden'; end if;
  v_pat := case when nullif(trim(coalesce(p_q, '')), '') is null then null
                else '%' || replace(replace(replace(trim(p_q), '\', '\\'), '%', '\%'), '_', '\_') || '%' end;
  return query
  select j.id, j.job_ref, j.title, j.status, s.label, j.priority, j.due_date, j.estimated_completion, j.submitted_at,
         c.name, c.company_name,
         (select string_agg(pr.full_name, ', ' order by a.created_at)
            from job_assignments a join profiles pr on pr.user_id = a.user_id where a.job_id = j.id),
         (j.due_date is not null and j.due_date < current_date and not s.is_terminal
            and j.status not in ('ready_for_collection', 'out_for_delivery')),
         count(*) over ()
  from jobs j
  join customers c on c.id = j.customer_id
  join workflow_stages s on s.workflow_id = j.workflow_id and s.status_key = j.status
  where j.org_id = p_org and j.status <> 'draft'
    and (has_perm(p_org, 'jobs.read_all')
         or exists (select 1 from job_assignments a where a.job_id = j.id and a.user_id = auth.uid()))
    and (p_status is null or j.status = any (p_status))
    and (v_pat is null or j.title ilike v_pat or coalesce(j.job_ref, '') ilike v_pat
         or c.name ilike v_pat or coalesce(c.company_name, '') ilike v_pat)
    and (p_assignee is null or exists (select 1 from job_assignments a2 where a2.job_id = j.id and a2.user_id = p_assignee))
    and (not coalesce(p_overdue, false)
         or (j.due_date is not null and j.due_date < current_date and not s.is_terminal
             and j.status not in ('ready_for_collection', 'out_for_delivery')))
  order by (case when j.priority = 'urgent' then 0 else 1 end), j.due_date nulls last, j.submitted_at desc
  limit least(greatest(coalesce(p_limit, 25), 1), 100) offset greatest(coalesce(p_offset, 0), 0);
end $$;

-- invoker (not definer): Row Level Security decides which jobs are counted for each person
create or replace function staff_overview(p_org uuid)
returns table (received_today bigint, active bigint, overdue bigint, awaiting_approval bigint, awaiting_payment bigint, ready bigint, completed_30d bigint)
language plpgsql stable set search_path = public as $$
#variable_conflict use_column
begin
  if auth.uid() is null or not has_perm(p_org, 'jobs.read') then raise exception 'forbidden'; end if;
  return query
  select count(*) filter (where j.submitted_at >= date_trunc('day', now())),
         count(*) filter (where not s.is_terminal),
         count(*) filter (where j.due_date < current_date and not s.is_terminal and j.status not in ('ready_for_collection', 'out_for_delivery')),
         count(*) filter (where j.status = 'awaiting_client_approval'),
         count(*) filter (where j.status = 'awaiting_payment'),
         count(*) filter (where j.status in ('ready_for_collection', 'out_for_delivery')),
         count(*) filter (where j.status = 'completed' and j.updated_at >= now() - interval '30 days')
  from jobs j
  join workflow_stages s on s.workflow_id = j.workflow_id and s.status_key = j.status
  where j.org_id = p_org and j.status <> 'draft';
end $$;

create or replace function job_next_options(p_job_id uuid)
returns table (status_key text, label text, allowed boolean, reason text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_job jobs%rowtype;
begin
  if auth.uid() is null or not can_staff_see_job(p_job_id) then raise exception 'job_not_found'; end if;
  select * into v_job from jobs where id = p_job_id;
  return query
  select s.status_key, s.label, (t.pr is null), t.pr
  from workflow_stages s
  cross join lateral (select transition_problem(v_job, s.status_key, 'note', 'internal note') as pr) t
  where s.workflow_id = v_job.workflow_id and s.status_key not in ('draft', v_job.status)
  order by s.off_track, s.position;
end $$;

-- everything the staff job page needs besides the job row itself, in one call
create or replace function staff_job_activity(p_job_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_job  jobs%rowtype;
  v_seen boolean;
begin
  if auth.uid() is null or not can_staff_see_job(p_job_id) then raise exception 'job_not_found'; end if;
  select * into v_job from jobs where id = p_job_id;
  v_seen := has_perm(v_job.org_id, 'customers.read');
  return jsonb_build_object(
    'customer', (select jsonb_build_object('name', c.name, 'company_name', c.company_name,
                   'email', case when v_seen then c.email end, 'phone', case when v_seen then c.phone end)
                 from customers c where c.id = v_job.customer_id),
    'assignees', coalesce((select jsonb_agg(jsonb_build_object('user_id', a.user_id, 'full_name', coalesce(p.full_name, ''), 'role_on_job', a.role_on_job) order by a.created_at)
                           from job_assignments a left join profiles p on p.user_id = a.user_id where a.job_id = p_job_id), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'from_status', h.from_status, 'to_status', h.to_status,
                           'label', coalesce(s.label, h.to_status), 'client_note', h.client_note, 'internal_note', h.internal_note,
                           'actor_name', coalesce(p.full_name, ''), 'created_at', h.created_at) order by h.created_at desc)
                         from job_status_history h
                         left join workflow_stages s on s.workflow_id = v_job.workflow_id and s.status_key = h.to_status
                         left join profiles p on p.user_id = h.changed_by
                         where h.job_id = p_job_id), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'body', n.body, 'author_name', coalesce(p.full_name, ''), 'created_at', n.created_at) order by n.created_at desc)
                       from job_notes n left join profiles p on p.user_id = n.author_id where n.job_id = p_job_id), '[]'::jsonb),
    'controls', coalesce((select jsonb_build_object('approved_at', k.approved_at, 'approval_note', k.approval_note,
                            'payment_cleared_at', k.payment_cleared_at, 'payment_note', k.payment_note)
                          from job_controls k where k.job_id = p_job_id), '{}'::jsonb)
  );
end $$;

create or replace function set_business_setting(p_org uuid, p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_old jsonb;
begin
  if auth.uid() is null or not has_perm(p_org, 'settings.manage') then raise exception 'forbidden'; end if;
  if p_key <> 'enforce_payment_gate' then raise exception 'invalid_setting'; end if;
  if jsonb_typeof(p_value) <> 'boolean' then raise exception 'invalid_value'; end if;
  select value into v_old from business_settings where org_id = p_org and key = p_key;
  insert into business_settings (org_id, key, value, updated_by) values (p_org, p_key, p_value, auth.uid())
  on conflict (org_id, key) do update set value = excluded.value, updated_by = auth.uid(), updated_at = now();
  insert into audit_logs (org_id, actor_id, action, entity, before, after)
  values (p_org, auth.uid(), 'setting.changed', 'business_settings',
          jsonb_build_object(p_key, v_old), jsonb_build_object(p_key, p_value));
end $$;

-- ---------------------------------------------------------------------------
-- email queue: used by the server worker with the service role, never by browsers
-- ---------------------------------------------------------------------------
create or replace function claim_outbox(p_limit int default 25) returns setof outbox
language plpgsql security definer set search_path = public as $$
begin
  -- a worker that died while sending: give up on it after 5 tries, otherwise let it be claimed again
  update outbox set status = 'failed', last_error = 'abandoned after repeated crashes', locked_at = null
  where status = 'sending' and locked_at < now() - interval '10 minutes' and attempts >= 5;

  return query
  update outbox o set status = 'sending', attempts = o.attempts + 1, locked_at = now()
  where o.id in (
    select q.id from outbox q
    where (q.status in ('pending', 'retry') and q.next_attempt_at <= now())
       or (q.status = 'sending' and q.locked_at < now() - interval '10 minutes')
    order by q.created_at
    limit least(greatest(coalesce(p_limit, 25), 1), 100)
    for update skip locked
  )
  returning o.*;
end $$;

create or replace function mark_outbox_sent(p_id uuid) returns void
language sql security definer set search_path = public as $$
  update outbox set status = 'sent', sent_at = now(), last_error = null, locked_at = null where id = p_id and status = 'sending';
$$;

create or replace function mark_outbox_failed(p_id uuid, p_error text) returns void
language sql security definer set search_path = public as $$
  update outbox
  set status = case when attempts >= 5 then 'failed' else 'retry' end,
      last_error = left(coalesce(p_error, 'unknown error'), 500),
      next_attempt_at = now() + (attempts * attempts) * interval '1 minute',
      locked_at = null
  where id = p_id and status = 'sending';
$$;

-- ---------------------------------------------------------------------------
-- submit_job: now also queues the confirmation email and alerts staff
-- ---------------------------------------------------------------------------
create or replace function submit_job(p_job_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_job   jobs%rowtype;
  v_org   organisations%rowtype;
  v_year  int;
  v_num   int;
  v_ref   text;
  v_staff record;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select j.* into v_job
  from jobs j join customers c on c.id = j.customer_id
  where j.id = p_job_id and c.user_id = auth.uid() and c.status = 'active'
  for update of j;
  if not found then raise exception 'job_not_found' using errcode = 'P0002'; end if;
  if v_job.status <> 'draft' then raise exception 'not_a_draft' using errcode = '22023'; end if;
  if not exists (select 1 from job_items where job_id = v_job.id) then raise exception 'no_items' using errcode = '22023'; end if;
  if v_job.due_date is not null and v_job.due_date < current_date then raise exception 'due_date_in_past' using errcode = '22023'; end if;

  v_year := extract(year from now())::int;
  insert into job_counters (org_id, year, last_number) values (v_job.org_id, v_year, 1)
  on conflict (org_id, year) do update set last_number = job_counters.last_number + 1
  returning last_number into v_num;
  v_ref := 'JOB-' || v_year || '-' || lpad(v_num::text, 4, '0');

  update jobs set job_ref = v_ref, status = 'submitted', submitted_at = now() where id = v_job.id;

  insert into job_status_history (org_id, job_id, from_status, to_status, changed_by, client_note)
  values (v_job.org_id, v_job.id, 'draft', 'submitted', auth.uid(), 'Your job has been received. Our team will review it shortly.');

  insert into audit_logs (org_id, actor_id, action, entity, entity_id, before, after)
  values (v_job.org_id, auth.uid(), 'job.submitted', 'job', v_job.id,
          jsonb_build_object('status', 'draft'), jsonb_build_object('status', 'submitted', 'job_ref', v_ref));

  select * into v_org from organisations where id = v_job.org_id;
  perform enqueue_notice(v_job.org_id, auth.uid(), 'job_submitted', 'Job submitted: ' || v_ref,
    'We have received "' || v_job.title || '". You can track it any time.',
    '/portal/jobs/' || v_job.id, 'job:' || v_job.id || ':submitted', 'job_submitted',
    jsonb_build_object('org_name', v_org.name, 'job_ref', v_ref, 'title', v_job.title, 'link', '/portal/jobs/' || v_job.id));

  -- tell the people who triage new work
  for v_staff in
    select distinct m.user_id
    from org_members m
    join role_permissions a on a.role_id = m.role_id and a.permission_key = 'jobs.read_all'
    join role_permissions b on b.role_id = m.role_id and b.permission_key = 'jobs.update_status'
    where m.org_id = v_job.org_id and m.status = 'active'
  loop
    perform enqueue_notice(v_job.org_id, v_staff.user_id, 'job_received', 'New job: ' || v_ref,
      v_job.title, '/admin/jobs/' || v_job.id, 'job:' || v_job.id || ':received', null, null);
  end loop;

  return v_ref;
end $$;

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------
revoke all on job_assignments, job_controls, job_notes, business_settings, notification_preferences, outbox from anon, authenticated;

grant select on job_assignments, job_controls, job_notes, business_settings to authenticated;
grant select on notification_preferences to authenticated;
grant insert (user_id, email_enabled) on notification_preferences to authenticated;
grant update (email_enabled, updated_at) on notification_preferences to authenticated;

-- new functions start out callable by everyone; close that, then open only what is needed
revoke all on function
  org_setting_bool(uuid, text, boolean), can_staff_see_job(uuid),
  enqueue_notice(uuid, uuid, text, text, text, text, text, text, jsonb),
  transition_problem(jobs, text, text, text), transition_job(uuid, text, text, text),
  record_client_approval(uuid, text), set_estimated_completion(uuid, date), add_job_note(uuid, text),
  assign_job(uuid, uuid, text), unassign_job(uuid, uuid), list_assignable_staff(uuid),
  staff_list_jobs(uuid, text[], text, uuid, boolean, int, int), staff_overview(uuid),
  job_next_options(uuid), staff_job_activity(uuid), set_business_setting(uuid, text, jsonb),
  claim_outbox(int), mark_outbox_sent(uuid), mark_outbox_failed(uuid, text)
from public, anon, authenticated;

grant execute on function
  can_staff_see_job(uuid), transition_job(uuid, text, text, text), record_client_approval(uuid, text),
  set_estimated_completion(uuid, date), add_job_note(uuid, text), assign_job(uuid, uuid, text), unassign_job(uuid, uuid),
  list_assignable_staff(uuid), staff_list_jobs(uuid, text[], text, uuid, boolean, int, int), staff_overview(uuid),
  job_next_options(uuid), staff_job_activity(uuid), set_business_setting(uuid, text, jsonb)
to authenticated;

grant execute on function claim_outbox(int), mark_outbox_sent(uuid), mark_outbox_failed(uuid, text) to service_role;
