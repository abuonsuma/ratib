-- Development seed. NEVER run this against production: it creates users with a known password.
-- Business: "Demo Print House" (slug demo-print). Logins (password for all: Passw0rd!demo)
--   admin@demo.test       Super Administrator
--   manager@demo.test     Manager
--   cs@demo.test          Customer Service
--   designer@demo.test    Designer      (assigned to JOB-2026-0003)
--   operator@demo.test    Production Operator (assigned to JOB-2026-0002)
--   accountant@demo.test  Accountant / Cashier
--   client@demo.test      Client (Ama Mensah, Mensah Events Ltd)
--   client2@demo.test     Client (Kofi Boateng)

do $$
declare
  v_org uuid;
  v_wf uuid;
  v_admin uuid := '00000000-0000-4000-8000-000000000001';
  v_manager uuid := '00000000-0000-4000-8000-000000000002';
  v_client uuid := '00000000-0000-4000-8000-000000000003';
  v_client2 uuid := '00000000-0000-4000-8000-000000000004';
  v_designer uuid := '00000000-0000-4000-8000-000000000005';
  v_operator uuid := '00000000-0000-4000-8000-000000000006';
  v_accountant uuid := '00000000-0000-4000-8000-000000000007';
  v_cs uuid := '00000000-0000-4000-8000-000000000008';
  v_cust uuid;
  v_cust2 uuid;
  v_cat_cards uuid;
  v_cat_banner uuid;
  v_cat_book uuid;
  v_job uuid;
  u record;
begin
  insert into organisations (name, slug) values ('Demo Print House', 'demo-print')
  on conflict (slug) do nothing;
  select id into v_org from organisations where slug = 'demo-print';
  perform seed_org_defaults(v_org);
  select id into v_wf from workflows where org_id = v_org and is_default;

  -- auth users (GoTrue-compatible rows so email + password login works locally)
  for u in
    select * from (values
      (v_admin,   'admin@demo.test',   'Esi Owusu',     null::text,   null::text),
      (v_manager, 'manager@demo.test', 'Yaw Asante',    null,         null),
      (v_designer,   'designer@demo.test',   'Efua Quartey',  null, null),
      (v_operator,   'operator@demo.test',   'Kwame Darko',   null, null),
      (v_accountant, 'accountant@demo.test', 'Abena Sarpong', null, null),
      (v_cs,         'cs@demo.test',         'Nana Adjei',    null, null),
      (v_client,  'client@demo.test',  'Ama Mensah',    '0244000111', 'demo-print'),
      (v_client2, 'client2@demo.test', 'Kofi Boateng',  '0200000222', 'demo-print')
    ) as t(id, email, full_name, phone, org_slug)
  loop
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                            confirmation_token, recovery_token, email_change, email_change_token_new)
    values ('00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email,
            crypt('Passw0rd!demo', gen_salt('bf')), now(),
            '{"provider":"email","providers":["email"]}',
            jsonb_strip_nulls(jsonb_build_object('full_name', u.full_name, 'phone', u.phone, 'org_slug', u.org_slug)),
            now(), now(), '', '', '', '')
    on conflict (id) do nothing;

    insert into auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), u.id,
            jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
            'email', u.id::text, now(), now(), now())
    on conflict do nothing;
  end loop;

  -- staff memberships (clients were attached automatically by the sign-up trigger)
  insert into org_members (org_id, user_id, role_id)
  select v_org, v_admin,   id from roles where org_id = v_org and key = 'super_admin'
  on conflict do nothing;
  insert into org_members (org_id, user_id, role_id)
  select v_org, v_manager, id from roles where org_id = v_org and key = 'manager'
  on conflict do nothing;

  insert into org_members (org_id, user_id, role_id)
  select v_org, x.uid, r.id from (values (v_designer, 'designer'), (v_operator, 'operator'), (v_accountant, 'accountant'), (v_cs, 'customer_service')) as x(uid, rk)
  join roles r on r.org_id = v_org and r.key = x.rk
  on conflict do nothing;

  update customers set company_name = 'Mensah Events Ltd' where user_id = v_client;
  select id into v_cust  from customers where user_id = v_client;
  select id into v_cust2 from customers where user_id = v_client2;

  select id into v_cat_cards  from service_categories where org_id = v_org and slug = 'business-cards';
  select id into v_cat_banner from service_categories where org_id = v_org and slug = 'banners-signage';
  select id into v_cat_book   from service_categories where org_id = v_org and slug = 'book-printing';

  if not exists (select 1 from jobs where org_id = v_org) then
    -- 1. completed
    insert into jobs (org_id, job_ref, customer_id, category_id, workflow_id, title, status, due_date, delivery_method, submitted_at, created_at)
    values (v_org, 'JOB-2026-0001', v_cust, v_cat_cards, v_wf, '500 business cards for Mensah Events', 'completed',
            current_date - 10, 'collection', now() - interval '14 days', now() - interval '14 days')
    returning id into v_job;
    insert into job_items (org_id, job_id, description, quantity, size, orientation, colour_mode, material, finishing)
    values (v_org, v_job, 'Business cards, double sided', 500, '90x55mm', 'landscape', 'full_colour', '350gsm matt', 'Matt lamination');
    insert into job_status_history (org_id, job_id, from_status, to_status, changed_by, client_note, created_at) values
      (v_org, v_job, 'draft',      'submitted',        v_client,  'Your job has been received. Our team will review it shortly.', now() - interval '14 days'),
      (v_org, v_job, 'submitted',  'under_review',     v_manager, 'We are checking your artwork.',                                 now() - interval '13 days'),
      (v_org, v_job, 'under_review','in_production',   v_manager, 'Printing has started.',                                         now() - interval '12 days'),
      (v_org, v_job, 'in_production','ready_for_collection', v_manager, 'Ready. Please bring your job reference.',                 now() - interval '11 days'),
      (v_org, v_job, 'ready_for_collection','completed', v_manager, 'Collected. Thank you!',                                       now() - interval '10 days');

    -- 2. in production
    insert into jobs (org_id, job_ref, customer_id, category_id, workflow_id, title, status, due_date, delivery_method, estimated_completion, submitted_at, created_at)
    values (v_org, 'JOB-2026-0002', v_cust, v_cat_banner, v_wf, 'Roll-up banner for Easter conference', 'in_production',
            current_date + 4, 'delivery', current_date + 3, now() - interval '3 days', now() - interval '3 days')
    returning id into v_job;
    update jobs set delivery_address = 'East Legon, Accra' where id = v_job;
    insert into job_items (org_id, job_id, description, quantity, size, orientation, colour_mode, material, finishing)
    values (v_org, v_job, 'Roll-up banner with stand', 2, '85x200cm', 'portrait', 'full_colour', 'Premium PVC', 'Carry bag');
    insert into job_status_history (org_id, job_id, from_status, to_status, changed_by, client_note, created_at) values
      (v_org, v_job, 'draft',     'submitted',    v_client,  'Your job has been received. Our team will review it shortly.', now() - interval '3 days'),
      (v_org, v_job, 'submitted', 'under_review', v_manager, 'Artwork looks good.',                                         now() - interval '3 days' + interval '2 hours'),
      (v_org, v_job, 'under_review','in_production', v_manager, 'Printing today. Expected ready in 3 days.',                now() - interval '1 day');

    -- 3. awaiting client approval (shows an action needed)
    insert into jobs (org_id, job_ref, customer_id, category_id, workflow_id, title, status, due_date, delivery_method, submitted_at, created_at)
    values (v_org, 'JOB-2026-0003', v_cust, v_cat_book, v_wf, 'Church anniversary brochure, 40 pages', 'awaiting_client_approval',
            current_date + 21, 'collection', now() - interval '2 days', now() - interval '2 days')
    returning id into v_job;
    insert into job_items (org_id, job_id, description, quantity, size, orientation, colour_mode, material, finishing)
    values (v_org, v_job, 'Saddle-stitched brochure', 300, 'A5', 'portrait', 'full_colour', '150gsm gloss inside, 250gsm cover', 'Saddle stitch');
    insert into job_status_history (org_id, job_id, from_status, to_status, changed_by, client_note, created_at) values
      (v_org, v_job, 'draft',      'submitted',    v_client,  'Your job has been received. Our team will review it shortly.', now() - interval '2 days'),
      (v_org, v_job, 'submitted',  'under_review', v_manager, 'Reviewing page count and paper options.',                      now() - interval '2 days' + interval '3 hours'),
      (v_org, v_job, 'under_review','awaiting_client_approval', v_manager, 'Please confirm the proof we sent by email.',       now() - interval '1 day');

    -- 4. submitted, another client (proves tenant-internal client isolation)
    insert into jobs (org_id, job_ref, customer_id, category_id, workflow_id, title, status, due_date, submitted_at, created_at)
    values (v_org, 'JOB-2026-0004', v_cust2, v_cat_cards, v_wf, '200 cards for Boateng Logistics', 'submitted',
            current_date + 7, now() - interval '5 hours', now() - interval '5 hours')
    returning id into v_job;
    insert into job_items (org_id, job_id, description, quantity, size, colour_mode)
    values (v_org, v_job, 'Business cards', 200, '90x55mm', 'full_colour');
    insert into job_status_history (org_id, job_id, from_status, to_status, changed_by, client_note, created_at)
    values (v_org, v_job, 'draft', 'submitted', v_client2, 'Your job has been received. Our team will review it shortly.', now() - interval '5 hours');

    insert into job_counters (org_id, year, last_number) values (v_org, extract(year from now())::int, 4)
    on conflict (org_id, year) do update set last_number = greatest(job_counters.last_number, 4);

    insert into job_assignments (org_id, job_id, user_id, role_on_job, assigned_by)
    select v_org, id, v_operator, 'operator', v_manager from jobs where job_ref = 'JOB-2026-0002' and org_id = v_org;
    insert into job_assignments (org_id, job_id, user_id, role_on_job, assigned_by)
    select v_org, id, v_designer, 'designer', v_manager from jobs where job_ref = 'JOB-2026-0003' and org_id = v_org;
    -- the two jobs that are past the payment stage were paid before the system existed
    insert into job_controls (job_id, org_id, payment_cleared_at, payment_cleared_by, payment_note)
    select id, v_org, now() - interval '12 days', v_manager, 'Paid in cash before go-live (seed data)' from jobs where job_ref in ('JOB-2026-0001', 'JOB-2026-0002') and org_id = v_org;

    insert into notifications (org_id, user_id, type, title, body, link, dedupe_key)
    select v_org, v_client, 'approval_needed', 'Approval needed: JOB-2026-0003',
           'Please confirm the proof we sent for your brochure.', '/portal/jobs/' || id, 'job:' || id || ':approval'
    from jobs where job_ref = 'JOB-2026-0003' and org_id = v_org;
  end if;
end $$;
