-- Ratib Phase 1: tenants, access, catalogue, workflow, jobs, files, history, audit, notifications.
-- Conventions
--   * Every business table carries org_id (multi-tenant). Row Level Security is ON for all of them.
--   * Browsers (role "authenticated") can only READ most tables. All writes to jobs go through the
--     security-definer functions at the bottom (save_job_draft, submit_job), which validate everything.
--   * IMPORTANT for later migrations: Supabase grants new tables to anon/authenticated by default.
--     Every migration that adds a table must revoke those grants and add explicit ones (see end of file).

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create or replace function forbid_change() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end $$;

-- ---------------------------------------------------------------------------
-- tenants and people
-- ---------------------------------------------------------------------------
create table organisations (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  slug          text not null unique check (slug ~ '^[a-z0-9-]{2,40}$'),
  logo_url      text,
  primary_color text not null default '#1d4ed8',
  currency      text not null default 'GHS',
  status        text not null default 'active' check (status in ('active', 'suspended')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  full_name  text not null default '',
  phone      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table permissions (
  key         text primary key,
  description text not null
);

create table roles (
  id       uuid primary key default gen_random_uuid(),
  org_id   uuid not null references organisations (id) on delete cascade,
  key      text not null,
  name     text not null,
  is_staff boolean not null default true,
  unique (org_id, key)
);

create table role_permissions (
  role_id        uuid not null references roles (id) on delete cascade,
  permission_key text not null references permissions (key) on delete cascade,
  primary key (role_id, permission_key)
);

create table org_members (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organisations (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role_id    uuid not null references roles (id),
  status     text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);
create index org_members_user_idx on org_members (user_id);

create table customers (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organisations (id) on delete cascade,
  user_id      uuid references auth.users (id) on delete set null,
  name         text not null,
  email        text,
  phone        text,
  company_name text,
  status       text not null default 'active' check (status in ('active', 'blocked')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, user_id)
);
create index customers_org_idx on customers (org_id);

-- staff-only notes live apart from customers so clients can never read them
create table customer_notes (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organisations (id) on delete cascade,
  customer_id uuid not null references customers (id) on delete cascade,
  body        text not null,
  created_by  uuid references auth.users (id),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- permission helpers (security definer so policies can call them without recursion)
-- ---------------------------------------------------------------------------
create or replace function is_org_member(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from org_members m
    where m.org_id = p_org and m.user_id = auth.uid() and m.status = 'active'
  );
$$;

create or replace function has_perm(p_org uuid, p_perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from org_members m
    join role_permissions rp on rp.role_id = m.role_id
    where m.org_id = p_org and m.user_id = auth.uid() and m.status = 'active'
      and rp.permission_key = p_perm
  );
$$;

create or replace function my_customer_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select c.id from customers c where c.user_id = auth.uid() and c.status = 'active';
$$;

-- ---------------------------------------------------------------------------
-- catalogue and workflow
-- ---------------------------------------------------------------------------
create table workflows (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organisations (id) on delete cascade,
  name       text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index workflows_one_default_idx on workflows (org_id) where is_default;

create table workflow_stages (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organisations (id) on delete cascade,
  workflow_id       uuid not null references workflows (id) on delete cascade,
  status_key        text not null check (status_key ~ '^[a-z_]{2,40}$'),
  label             text not null,
  position          int  not null,
  requires_approval boolean not null default false,
  requires_payment  boolean not null default false,
  client_visible    boolean not null default true,
  notify_client     boolean not null default true,
  off_track         boolean not null default false, -- on_hold / cancelled: shown apart from the main progress line
  is_terminal       boolean not null default false,
  unique (workflow_id, status_key),
  unique (workflow_id, position)
);

create table service_categories (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organisations (id) on delete cascade,
  name        text not null,
  slug        text not null,
  description text,
  sort_order  int not null default 0,
  active      boolean not null default true,
  workflow_id uuid references workflows (id) on delete set null,
  unique (org_id, slug)
);

-- ---------------------------------------------------------------------------
-- jobs
-- ---------------------------------------------------------------------------
create table job_counters (
  org_id      uuid not null references organisations (id) on delete cascade,
  year        int  not null,
  last_number int  not null default 0,
  primary key (org_id, year)
);

create table jobs (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references organisations (id) on delete cascade,
  job_ref              text,                        -- assigned on submit, so abandoned drafts never burn numbers
  customer_id          uuid not null references customers (id),
  category_id          uuid not null references service_categories (id),
  workflow_id          uuid not null references workflows (id),
  title                text not null check (char_length(title) between 3 and 200),
  description          text,
  status               text not null default 'draft',
  priority             text not null default 'normal' check (priority in ('normal', 'urgent')),
  due_date             date,
  delivery_method      text not null default 'collection' check (delivery_method in ('collection', 'delivery')),
  delivery_address     text,
  instructions         text,
  estimated_completion date,
  submitted_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, job_ref),
  foreign key (workflow_id, status) references workflow_stages (workflow_id, status_key)
);
create index jobs_org_status_idx   on jobs (org_id, status);
create index jobs_customer_idx     on jobs (customer_id, created_at desc);
create index jobs_org_created_idx  on jobs (org_id, created_at desc);

create table job_items (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organisations (id) on delete cascade,
  job_id       uuid not null references jobs (id) on delete cascade,
  position     int  not null default 1,
  description  text not null check (char_length(description) between 3 and 500),
  quantity     int  not null check (quantity between 1 and 10000000),
  size         text,
  orientation  text not null default 'not_applicable' check (orientation in ('portrait', 'landscape', 'not_applicable')),
  colour_mode  text not null default 'full_colour' check (colour_mode in ('full_colour', 'black_white')),
  material     text,
  finishing    text
);
create index job_items_job_idx on job_items (job_id);

create table job_files (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organisations (id) on delete cascade,
  job_id       uuid not null references jobs (id) on delete cascade,
  storage_path text not null unique,
  filename     text not null,
  mime_type    text,
  size_bytes   bigint not null check (size_bytes between 1 and 52428800),
  kind         text not null default 'design' check (kind in ('reference', 'design', 'deliverable')),
  uploaded_by  uuid references auth.users (id),
  created_at   timestamptz not null default now()
);
create index job_files_job_idx on job_files (job_id);

create table job_status_history (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organisations (id) on delete cascade,
  job_id        uuid not null references jobs (id) on delete cascade,
  from_status   text,
  to_status     text not null,
  changed_by    uuid references auth.users (id),
  client_note   text,
  internal_note text,
  created_at    timestamptz not null default now()
);
create index job_status_history_job_idx on job_status_history (job_id, created_at);
create trigger job_status_history_no_update before update or delete on job_status_history
  for each row execute function forbid_change();

create table audit_logs (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid references organisations (id) on delete cascade,
  actor_id   uuid references auth.users (id),
  action     text not null,
  entity     text not null,
  entity_id  uuid,
  before     jsonb,
  after      jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_org_idx on audit_logs (org_id, created_at desc);
create trigger audit_logs_no_update before update or delete on audit_logs
  for each row execute function forbid_change();

create table notifications (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organisations (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  type       text not null,
  title      text not null,
  body       text,
  link       text,
  dedupe_key text,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create unique index notifications_dedupe_idx on notifications (user_id, dedupe_key) where dedupe_key is not null;
create index notifications_user_idx on notifications (user_id, read_at, created_at desc);

-- updated_at triggers
create trigger organisations_updated before update on organisations for each row execute function set_updated_at();
create trigger profiles_updated      before update on profiles      for each row execute function set_updated_at();
create trigger customers_updated     before update on customers     for each row execute function set_updated_at();
create trigger jobs_updated          before update on jobs          for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- permissions catalogue
-- ---------------------------------------------------------------------------
insert into permissions (key, description) values
  ('jobs.read',          'See all jobs in the business'),
  ('jobs.update_status', 'Move jobs through workflow stages'),
  ('jobs.assign',        'Assign jobs to staff'),
  ('customers.read',     'See customer records'),
  ('catalogue.manage',   'Edit services, pricing and workflows'),
  ('staff.manage',       'Invite staff and change roles'),
  ('audit.read',         'Read the audit log'),
  ('settings.manage',    'Change business settings');

-- ---------------------------------------------------------------------------
-- new auth user -> profile (+ client membership when signing up through a tenant page)
-- The role is ALWAYS client here. Staff are added by an administrator, never by sign-up metadata.
-- ---------------------------------------------------------------------------
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_org   organisations%rowtype;
  v_role  uuid;
  v_name  text;
  v_phone text;
begin
  v_name  := coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(coalesce(new.email, ''), '@', 1));
  v_phone := nullif(trim(new.raw_user_meta_data ->> 'phone'), '');

  insert into profiles (user_id, full_name, phone) values (new.id, v_name, v_phone)
  on conflict (user_id) do nothing;

  select * into v_org from organisations
  where slug = (new.raw_user_meta_data ->> 'org_slug') and status = 'active';

  if found then
    select id into v_role from roles where org_id = v_org.id and key = 'client';
    if v_role is not null then
      insert into org_members (org_id, user_id, role_id) values (v_org.id, new.id, v_role)
      on conflict (org_id, user_id) do nothing;
      insert into customers (org_id, user_id, name, email, phone) values (v_org.id, new.id, v_name, new.email, v_phone)
      on conflict (org_id, user_id) do nothing;
    end if;
  end if;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- ---------------------------------------------------------------------------
-- onboarding: default roles, permissions, workflow and categories for a new business
-- Called by the platform owner tooling / seed, never by browsers.
-- ---------------------------------------------------------------------------
create or replace function seed_org_defaults(p_org uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_wf uuid;
  r record;
  v_role uuid;
begin
  -- roles
  insert into roles (org_id, key, name, is_staff) values
    (p_org, 'super_admin',      'Super Administrator', true),
    (p_org, 'manager',          'Manager',             true),
    (p_org, 'customer_service', 'Customer Service',    true),
    (p_org, 'designer',         'Designer',            true),
    (p_org, 'operator',         'Production Operator', true),
    (p_org, 'accountant',       'Accountant / Cashier', true),
    (p_org, 'delivery',         'Delivery Staff',      true),
    (p_org, 'client',           'Client',              false)
  on conflict (org_id, key) do nothing;

  -- role -> permission map
  for r in
    select * from (values
      ('super_admin',      'jobs.read'), ('super_admin', 'jobs.update_status'), ('super_admin', 'jobs.assign'),
      ('super_admin',      'customers.read'), ('super_admin', 'catalogue.manage'), ('super_admin', 'staff.manage'),
      ('super_admin',      'audit.read'), ('super_admin', 'settings.manage'),
      ('manager',          'jobs.read'), ('manager', 'jobs.update_status'), ('manager', 'jobs.assign'),
      ('manager',          'customers.read'), ('manager', 'catalogue.manage'), ('manager', 'audit.read'),
      ('customer_service', 'jobs.read'), ('customer_service', 'jobs.update_status'), ('customer_service', 'customers.read'),
      ('designer',         'jobs.read'),
      ('operator',         'jobs.read'), ('operator', 'jobs.update_status'),
      ('accountant',       'jobs.read'), ('accountant', 'customers.read'),
      ('delivery',         'jobs.read')
    ) as t(role_key, perm)
  loop
    select id into v_role from roles where org_id = p_org and key = r.role_key;
    insert into role_permissions (role_id, permission_key) values (v_role, r.perm) on conflict do nothing;
  end loop;

  -- default workflow
  insert into workflows (org_id, name, is_default) values (p_org, 'Standard job workflow', true)
  on conflict do nothing;
  select id into v_wf from workflows where org_id = p_org and is_default;

  insert into workflow_stages
    (org_id, workflow_id, status_key, label, position, requires_approval, requires_payment, off_track, is_terminal)
  values
    (p_org, v_wf, 'draft',                  'Draft',                    1,  false, false, false, false),
    (p_org, v_wf, 'submitted',              'Submitted',                2,  false, false, false, false),
    (p_org, v_wf, 'under_review',           'Under Review',             3,  false, false, false, false),
    (p_org, v_wf, 'awaiting_quotation',     'Awaiting Quotation',       4,  false, false, false, false),
    (p_org, v_wf, 'awaiting_client_approval','Awaiting Your Approval',  5,  true,  false, false, false),
    (p_org, v_wf, 'awaiting_payment',       'Awaiting Payment',         6,  false, false, false, false),
    (p_org, v_wf, 'payment_confirmed',      'Payment Confirmed',        7,  false, false, false, false),
    (p_org, v_wf, 'queued_for_production',  'Queued for Production',    8,  false, true,  false, false),
    (p_org, v_wf, 'in_production',          'In Production',            9,  false, true,  false, false),
    (p_org, v_wf, 'quality_check',          'Quality Check',            10, false, true,  false, false),
    (p_org, v_wf, 'ready_for_collection',   'Ready for Collection',     11, false, true,  false, false),
    (p_org, v_wf, 'out_for_delivery',       'Out for Delivery',         12, false, true,  false, false),
    (p_org, v_wf, 'completed',              'Completed',                13, false, true,  false, true),
    (p_org, v_wf, 'on_hold',                'On Hold',                  98, false, false, true,  false),
    (p_org, v_wf, 'cancelled',              'Cancelled',                99, false, false, true,  true)
  on conflict (workflow_id, status_key) do nothing;

  -- default categories
  insert into service_categories (org_id, name, slug, sort_order, workflow_id) values
    (p_org, 'Graphic design',                    'graphic-design',   1, v_wf),
    (p_org, 'Business cards',                    'business-cards',   2, v_wf),
    (p_org, 'Flyers and posters',                'flyers-posters',   3, v_wf),
    (p_org, 'Banners and signage',               'banners-signage',  4, v_wf),
    (p_org, 'Book printing and binding',         'book-printing',    5, v_wf),
    (p_org, 'Document printing and photocopying','document-printing',6, v_wf),
    (p_org, 'Branding and promotional materials','branding-promo',   7, v_wf),
    (p_org, 'Other custom services',             'other',            8, v_wf)
  on conflict (org_id, slug) do nothing;
end $$;

-- ---------------------------------------------------------------------------
-- public, read-only tenant lookup for the login/register pages (no table access for anon)
-- ---------------------------------------------------------------------------
create or replace function get_org_public(p_slug text)
returns table (id uuid, name text, slug text, logo_url text, primary_color text)
language sql stable security definer set search_path = public as $$
  select o.id, o.name, o.slug, o.logo_url, o.primary_color
  from organisations o where o.slug = p_slug and o.status = 'active';
$$;

-- ---------------------------------------------------------------------------
-- job writes: the ONLY way a client creates or changes a job
-- ---------------------------------------------------------------------------
create or replace function save_job_draft(p_org_id uuid, p_job_id uuid, p_payload jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_customer customers%rowtype;
  v_cat      service_categories%rowtype;
  v_wf       uuid;
  v_job_id   uuid := p_job_id;
  v_title    text;
  v_method   text;
  v_item     jsonb;
  v_pos      int := 0;
  v_qty      int;
  v_desc     text;
  v_orient   text;
  v_colour   text;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select * into v_customer from customers
  where org_id = p_org_id and user_id = auth.uid() and status = 'active';
  if not found then
    raise exception 'not_a_customer' using errcode = '42501';
  end if;

  v_title := trim(coalesce(p_payload ->> 'title', ''));
  if char_length(v_title) < 3 or char_length(v_title) > 200 then
    raise exception 'invalid_title' using errcode = '22023';
  end if;

  select * into v_cat from service_categories
  where id = nullif(p_payload ->> 'category_id', '')::uuid and org_id = p_org_id and active;
  if not found then
    raise exception 'invalid_category' using errcode = '22023';
  end if;

  select id into v_wf from workflows where org_id = p_org_id and is_default;
  v_wf := coalesce(v_cat.workflow_id, v_wf);
  if v_wf is null then
    raise exception 'no_workflow' using errcode = '22023';
  end if;

  v_method := coalesce(nullif(p_payload ->> 'delivery_method', ''), 'collection');
  if v_method not in ('collection', 'delivery') then
    raise exception 'invalid_delivery_method' using errcode = '22023';
  end if;
  if v_method = 'delivery' and char_length(trim(coalesce(p_payload ->> 'delivery_address', ''))) < 5 then
    raise exception 'delivery_address_required' using errcode = '22023';
  end if;

  if jsonb_typeof(p_payload -> 'items') is distinct from 'array'
     or jsonb_array_length(p_payload -> 'items') not between 1 and 20 then
    raise exception 'invalid_items' using errcode = '22023';
  end if;

  if v_job_id is null then
    insert into jobs (org_id, customer_id, category_id, workflow_id, title, description, status, priority,
                      due_date, delivery_method, delivery_address, instructions)
    values (p_org_id, v_customer.id, v_cat.id, v_wf, v_title,
            nullif(trim(p_payload ->> 'description'), ''), 'draft',
            case when p_payload ->> 'priority' = 'urgent' then 'urgent' else 'normal' end,
            nullif(p_payload ->> 'due_date', '')::date, v_method,
            nullif(trim(p_payload ->> 'delivery_address'), ''),
            nullif(trim(p_payload ->> 'instructions'), ''))
    returning id into v_job_id;
  else
    update jobs set category_id = v_cat.id, workflow_id = v_wf, title = v_title,
           description = nullif(trim(p_payload ->> 'description'), ''),
           priority = case when p_payload ->> 'priority' = 'urgent' then 'urgent' else 'normal' end,
           due_date = nullif(p_payload ->> 'due_date', '')::date,
           delivery_method = v_method,
           delivery_address = nullif(trim(p_payload ->> 'delivery_address'), ''),
           instructions = nullif(trim(p_payload ->> 'instructions'), '')
    where id = v_job_id and customer_id = v_customer.id and status = 'draft';
    if not found then
      raise exception 'draft_not_found' using errcode = 'P0002';
    end if;
    delete from job_items where job_id = v_job_id;
  end if;

  for v_item in select * from jsonb_array_elements(p_payload -> 'items') loop
    v_pos := v_pos + 1;
    v_desc := trim(coalesce(v_item ->> 'description', ''));
    v_qty := (v_item ->> 'quantity')::int;
    v_orient := coalesce(nullif(v_item ->> 'orientation', ''), 'not_applicable');
    v_colour := coalesce(nullif(v_item ->> 'colour_mode', ''), 'full_colour');
    if char_length(v_desc) < 3 or char_length(v_desc) > 500 then
      raise exception 'invalid_item_description' using errcode = '22023';
    end if;
    if v_qty is null or v_qty < 1 or v_qty > 10000000 then
      raise exception 'invalid_quantity' using errcode = '22023';
    end if;
    if v_orient not in ('portrait', 'landscape', 'not_applicable') then
      raise exception 'invalid_orientation' using errcode = '22023';
    end if;
    if v_colour not in ('full_colour', 'black_white') then
      raise exception 'invalid_colour_mode' using errcode = '22023';
    end if;
    insert into job_items (org_id, job_id, position, description, quantity, size, orientation, colour_mode, material, finishing)
    values (p_org_id, v_job_id, v_pos, v_desc, v_qty,
            nullif(trim(v_item ->> 'size'), ''), v_orient, v_colour,
            nullif(trim(v_item ->> 'material'), ''), nullif(trim(v_item ->> 'finishing'), ''));
  end loop;

  return v_job_id;
end $$;

create or replace function submit_job(p_job_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_job  jobs%rowtype;
  v_year int;
  v_num  int;
  v_ref  text;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select j.* into v_job
  from jobs j join customers c on c.id = j.customer_id
  where j.id = p_job_id and c.user_id = auth.uid() and c.status = 'active'
  for update of j;
  if not found then
    raise exception 'job_not_found' using errcode = 'P0002';
  end if;
  if v_job.status <> 'draft' then
    raise exception 'not_a_draft' using errcode = '22023';
  end if;
  if not exists (select 1 from job_items where job_id = v_job.id) then
    raise exception 'no_items' using errcode = '22023';
  end if;
  if v_job.due_date is not null and v_job.due_date < current_date then
    raise exception 'due_date_in_past' using errcode = '22023';
  end if;

  v_year := extract(year from now())::int;
  insert into job_counters (org_id, year, last_number) values (v_job.org_id, v_year, 1)
  on conflict (org_id, year) do update set last_number = job_counters.last_number + 1
  returning last_number into v_num;
  v_ref := 'JOB-' || v_year || '-' || lpad(v_num::text, 4, '0');

  update jobs set job_ref = v_ref, status = 'submitted', submitted_at = now() where id = v_job.id;

  insert into job_status_history (org_id, job_id, from_status, to_status, changed_by, client_note)
  values (v_job.org_id, v_job.id, 'draft', 'submitted', auth.uid(),
          'Your job has been received. Our team will review it shortly.');

  insert into audit_logs (org_id, actor_id, action, entity, entity_id, before, after)
  values (v_job.org_id, auth.uid(), 'job.submitted', 'job', v_job.id,
          jsonb_build_object('status', 'draft'), jsonb_build_object('status', 'submitted', 'job_ref', v_ref));

  insert into notifications (org_id, user_id, type, title, body, link, dedupe_key)
  values (v_job.org_id, auth.uid(), 'job_submitted', 'Job submitted: ' || v_ref,
          'We have received "' || v_job.title || '". You can track it any time.',
          '/portal/jobs/' || v_job.id, 'job:' || v_job.id || ':submitted')
  on conflict do nothing;

  return v_ref;
end $$;

create or replace function delete_job_draft(p_job_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from jobs j using customers c
  where j.id = p_job_id and c.id = j.customer_id and c.user_id = auth.uid() and j.status = 'draft';
  if not found then
    raise exception 'draft_not_found' using errcode = 'P0002';
  end if;
end $$;

-- client-safe timeline: only client-visible stages, and never internal_note
create or replace view client_job_timeline as
select h.id, h.job_id, h.org_id, h.from_status, h.to_status, s.label, h.client_note, h.created_at
from job_status_history h
join jobs j on j.id = h.job_id
join workflow_stages s on s.workflow_id = j.workflow_id and s.status_key = h.to_status
where j.customer_id in (select my_customer_ids())
  and s.client_visible;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table organisations      enable row level security;
alter table profiles           enable row level security;
alter table permissions        enable row level security;
alter table roles              enable row level security;
alter table role_permissions   enable row level security;
alter table org_members        enable row level security;
alter table customers          enable row level security;
alter table customer_notes     enable row level security;
alter table workflows          enable row level security;
alter table workflow_stages    enable row level security;
alter table service_categories enable row level security;
alter table job_counters       enable row level security;
alter table jobs               enable row level security;
alter table job_items          enable row level security;
alter table job_files          enable row level security;
alter table job_status_history enable row level security;
alter table audit_logs         enable row level security;
alter table notifications      enable row level security;

create policy org_select on organisations for select using (is_org_member(id));

create policy profile_select_own on profiles for select using (user_id = auth.uid());
create policy profile_update_own on profiles for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy permissions_select on permissions for select to authenticated using (true);

create policy roles_select on roles for select using (is_org_member(org_id));
create policy role_permissions_select on role_permissions for select
  using (exists (select 1 from roles r where r.id = role_id and is_org_member(r.org_id)));

create policy members_select_own   on org_members for select using (user_id = auth.uid());
create policy members_select_staff on org_members for select using (has_perm(org_id, 'staff.manage'));

create policy customers_select_own   on customers for select using (user_id = auth.uid());
create policy customers_select_staff on customers for select using (has_perm(org_id, 'customers.read'));
create policy customers_update_own   on customers for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy customer_notes_staff on customer_notes for select using (has_perm(org_id, 'customers.read'));

create policy workflows_select on workflows for select using (is_org_member(org_id));
create policy stages_select    on workflow_stages for select using (is_org_member(org_id));
create policy categories_select on service_categories for select
  using (is_org_member(org_id) and (active or has_perm(org_id, 'catalogue.manage')));

create policy jobs_select_own   on jobs for select using (customer_id in (select my_customer_ids()));
create policy jobs_select_staff on jobs for select using (has_perm(org_id, 'jobs.read'));

-- these inherit jobs visibility through the sub-select (which is itself filtered by jobs RLS)
create policy job_items_select on job_items for select using (exists (select 1 from jobs j where j.id = job_id));
create policy job_files_select on job_files for select using (exists (select 1 from jobs j where j.id = job_id));

create policy job_files_insert_client on job_files for insert with check (
  uploaded_by = auth.uid()
  and kind in ('reference', 'design')
  and exists (
    select 1 from jobs j
    where j.id = job_id and j.org_id = job_files.org_id
      and j.customer_id in (select my_customer_ids())
      and j.status in ('draft', 'submitted', 'under_review')
  )
);
create policy job_files_insert_staff on job_files for insert with check (
  uploaded_by = auth.uid() and has_perm(org_id, 'jobs.update_status')
);
create policy job_files_delete_client on job_files for delete using (
  uploaded_by = auth.uid()
  and exists (select 1 from jobs j where j.id = job_id and j.status = 'draft' and j.customer_id in (select my_customer_ids()))
);

create policy history_select_staff on job_status_history for select using (has_perm(org_id, 'jobs.read'));
create policy audit_select_staff   on audit_logs for select using (has_perm(org_id, 'audit.read'));

create policy notifications_select_own on notifications for select using (user_id = auth.uid());
create policy notifications_update_own on notifications for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Grants: start from nothing, then open only what browsers need
-- ---------------------------------------------------------------------------
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated, public;

grant select on organisations, profiles, permissions, roles, role_permissions, org_members, customers,
  customer_notes, workflows, workflow_stages, service_categories, jobs, job_items, job_files,
  job_status_history, audit_logs, notifications, client_job_timeline to authenticated;

grant update (full_name, phone)                 on profiles      to authenticated;
grant update (name, phone, company_name)        on customers     to authenticated;
grant update (read_at)                          on notifications to authenticated;
grant insert, delete                            on job_files     to authenticated;

grant execute on function is_org_member(uuid), has_perm(uuid, text), my_customer_ids(),
  save_job_draft(uuid, uuid, jsonb), submit_job(uuid), delete_job_draft(uuid) to authenticated;
grant execute on function get_org_public(text) to anon, authenticated;
-- seed_org_defaults and handle_new_user stay server-only (service role / auth trigger).
