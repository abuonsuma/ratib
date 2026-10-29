-- Security tests: tenant isolation, client isolation, write restrictions, validation, immutability.
-- Run with run_db_tests.sh. Any failed check raises an exception and stops the run.
\set ON_ERROR_STOP on
\set QUIET on
set client_min_messages = notice;

create schema t;
grant usage on schema t to anon, authenticated;

create function t.ok(c boolean, msg text) returns void language plpgsql as $$
begin
  if c is not true then raise exception 'FAIL: %', msg; end if;
  raise notice 'PASS  %', msg;
end $$;

-- run a statement as the current role and require it to fail with an error containing `needle`
create function t.throws(q text, needle text) returns void language plpgsql as $$
begin
  begin
    execute q;
  exception when others then
    if sqlerrm ilike '%' || needle || '%' then
      raise notice 'PASS  rejected (%): %', needle, left(q, 70);
      return;
    end if;
    raise exception 'FAIL: wrong error for [%]: % (%)', q, sqlerrm, sqlstate;
  end;
  raise exception 'FAIL: expected error "%" but statement succeeded: %', needle, q;
end $$;

create function t.login(u uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', u::text, false); end $$;
grant execute on all functions in schema t to anon, authenticated;

-- fixtures
create temp table ids as
select
  (select id from organisations where slug = 'demo-print') as org_a,
  '00000000-0000-4000-8000-000000000001'::uuid as admin,
  '00000000-0000-4000-8000-000000000002'::uuid as manager,
  '00000000-0000-4000-8000-000000000003'::uuid as ama,
  '00000000-0000-4000-8000-000000000004'::uuid as kofi;
grant select on ids to anon, authenticated;

-- ---------------------------------------------------------------- seed sanity (superuser)
select t.ok((select count(*) from workflow_stages ws join organisations o on o.id = ws.org_id where o.slug = 'demo-print') = 15, 'default workflow has 15 stages');
select t.ok((select count(*) from service_categories) = 8, '8 default service categories');
select t.ok((select count(*) from roles) = 8, '8 default roles');
select t.ok((select count(*) from jobs) = 4, '4 seeded jobs');
select t.ok((select r.key from org_members m join roles r on r.id = m.role_id where m.user_id = (select ama from ids)) = 'client', 'sign-up trigger made Ama a client');

-- second business, to prove tenant isolation
insert into organisations (name, slug) values ('Other Press', 'other-press');
select seed_org_defaults((select id from organisations where slug = 'other-press'));
insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-4000-8000-0000000000b1', 'client@other.test',
        '{"full_name":"Other Client","org_slug":"other-press"}', now(), now());
-- escalation attempt through sign-up metadata: must still land as plain client
insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-4000-8000-0000000000e1', 'sneaky@demo.test',
        '{"full_name":"Sneaky","org_slug":"demo-print","role":"super_admin","role_key":"super_admin"}', now(), now());
select t.ok((select r.key from org_members m join roles r on r.id = m.role_id where m.user_id = '00000000-0000-4000-8000-0000000000e1') = 'client', 'sign-up metadata cannot grant a staff role');
select t.ok((select count(*) from org_members where user_id = '00000000-0000-4000-8000-0000000000e1') = 1, 'sneaky user has exactly one membership');
select t.ok((select count(*) from profiles where user_id = '00000000-0000-4000-8000-0000000000b1') = 1, 'profile created on sign-up');

-- ---------------------------------------------------------------- anonymous visitors
set role anon;
select t.ok((select count(*) from get_org_public('demo-print')) = 1, 'anon can look up public tenant branding');
select t.ok((select count(*) from get_org_public('nope')) = 0, 'unknown tenant returns nothing');
select t.throws('select * from jobs', 'permission denied');
select t.throws('select * from customers', 'permission denied');
select t.throws('select * from organisations', 'permission denied');
select t.throws($$select submit_job('00000000-0000-4000-8000-000000000099')$$, 'permission denied');
reset role;

-- ---------------------------------------------------------------- client A (Ama)
select t.login((select ama from ids));
set role authenticated;

select t.ok((select count(*) from jobs) = 3, 'Ama sees exactly her 3 jobs');
select t.ok((select count(*) from jobs where job_ref = 'JOB-2026-0004') = 0, 'Ama cannot see Kofi''s job');
select t.ok((select count(*) from job_items) = 3, 'Ama sees only items of her own jobs');
select t.ok((select count(*) from customers) = 1, 'Ama sees only her own customer record');
select t.ok((select count(*) from profiles) = 1, 'Ama sees only her own profile');
select t.ok((select count(*) from job_status_history) = 0, 'clients have no direct access to raw status history');
select t.ok((select count(*) from client_job_timeline) = 11, 'Ama sees her client-safe timeline');
select t.ok((select count(*) from information_schema.columns where table_name = 'client_job_timeline' and column_name = 'internal_note') = 0, 'timeline exposes no internal_note column');
select t.ok((select count(*) from audit_logs) = 0, 'clients cannot read audit logs');
select t.ok((select count(*) from customer_notes) = 0, 'clients cannot read staff notes');
select t.ok((select count(*) from org_members) = 1, 'client sees only her own membership');
select t.ok((select count(*) from notifications) = 1, 'Ama sees only her own notification');
select t.ok((select count(*) from service_categories) = 8, 'Ama can read her business catalogue');
select t.ok((select count(*) from organisations) = 1, 'Ama sees only her own business');

select t.throws($$insert into jobs (org_id, customer_id, category_id, workflow_id, title) select org_id, id, (select id from service_categories limit 1), (select id from workflows limit 1), 'hack' from customers$$, 'permission denied');
select t.throws($$update jobs set status = 'completed'$$, 'permission denied');
select t.throws($$update jobs set title = 'x'$$, 'permission denied');
select t.throws($$delete from jobs$$, 'permission denied');
select t.throws($$update customers set status = 'blocked'$$, 'permission denied');
select t.throws($$insert into org_members (org_id, user_id, role_id) select org_id, user_id, role_id from org_members$$, 'permission denied');
select t.throws($$insert into audit_logs (action, entity) values ('x', 'y')$$, 'permission denied');
select t.throws($$insert into job_status_history (org_id, job_id, to_status) select org_id, id, 'completed' from jobs$$, 'permission denied');
select t.throws($$update notifications set title = 'changed'$$, 'permission denied');
select t.throws($$select seed_org_defaults((select id from organisations limit 1))$$, 'permission denied');

-- allowed self-service edits
update profiles set phone = '0555123456';
update customers set phone = '0555123456';
update notifications set read_at = now();
select t.ok((select count(*) from notifications where read_at is not null) = 1, 'client can mark own notification read');

-- validation through the draft function
select t.throws($$select save_job_draft((select org_a from ids), null, '{"title":"ab","category_id":"x","items":[]}'::jsonb)$$, 'invalid_title');
select t.throws($$select save_job_draft((select org_a from ids), null, jsonb_build_object('title','Valid title','category_id',gen_random_uuid(),'items','[{"description":"abc","quantity":1}]'::jsonb))$$, 'invalid_category');
select t.throws($$select save_job_draft((select org_a from ids), null, jsonb_build_object('title','Valid title','category_id',(select id from service_categories limit 1),'items','[]'::jsonb))$$, 'invalid_items');
select t.throws($$select save_job_draft((select org_a from ids), null, jsonb_build_object('title','Valid title','category_id',(select id from service_categories limit 1),'items','[{"description":"Cards","quantity":0}]'::jsonb))$$, 'invalid_quantity');
select t.throws($$select save_job_draft((select org_a from ids), null, jsonb_build_object('title','Valid title','category_id',(select id from service_categories limit 1),'items','[{"description":"Cards","quantity":99999999}]'::jsonb))$$, 'invalid_quantity');
select t.throws($$select save_job_draft((select org_a from ids), null, jsonb_build_object('title','Valid title','category_id',(select id from service_categories limit 1),'items','[{"description":"Cards","quantity":5,"orientation":"sideways"}]'::jsonb))$$, 'invalid_orientation');
select t.throws($$select save_job_draft((select org_a from ids), null, jsonb_build_object('title','Valid title','category_id',(select id from service_categories limit 1),'delivery_method','delivery','items','[{"description":"Cards","quantity":5}]'::jsonb))$$, 'delivery_address_required');
select t.throws($$select save_job_draft((select org_a from ids), null, jsonb_build_object('title','Valid title','category_id',(select id from service_categories limit 1),'delivery_method','drone','items','[{"description":"Cards","quantity":5}]'::jsonb))$$, 'invalid_delivery_method');

-- happy path: draft -> edit -> submit
create temp table made (job_id uuid, ref text);
grant all on made to authenticated;
insert into made (job_id) select save_job_draft(
  (select org_a from ids), null,
  jsonb_build_object('title', 'Wedding programmes', 'category_id', (select id from service_categories where slug = 'flyers-posters'),
    'due_date', (current_date + 10)::text, 'delivery_method', 'collection',
    'items', jsonb_build_array(
      jsonb_build_object('description', 'Programme booklet', 'quantity', 150, 'size', 'A5', 'orientation', 'portrait', 'colour_mode', 'full_colour'),
      jsonb_build_object('description', 'Thank-you cards', 'quantity', 150, 'size', '100x150mm', 'colour_mode', 'black_white'))));
select t.ok((select count(*) from jobs where status = 'draft') = 1, 'draft created');
select t.ok((select job_ref is null from jobs where status = 'draft'), 'drafts have no job reference yet');
select t.ok((select count(*) from job_items where job_id = (select job_id from made)) = 2, 'draft has 2 items');

select save_job_draft((select org_a from ids), (select job_id from made),
  jsonb_build_object('title', 'Wedding programmes (edited)', 'category_id', (select id from service_categories where slug = 'flyers-posters'),
    'due_date', (current_date + 10)::text, 'items', jsonb_build_array(jsonb_build_object('description', 'Programme booklet', 'quantity', 200))));
select t.ok((select count(*) from job_items where job_id = (select job_id from made)) = 1, 'editing a draft replaces its items');

-- a draft can take uploads of allowed kinds, never deliverables
insert into job_files (org_id, job_id, storage_path, filename, mime_type, size_bytes, kind, uploaded_by)
select (select org_a from ids), job_id, (select org_a from ids)::text || '/' || job_id::text || '/a.pdf', 'a.pdf', 'application/pdf', 1000, 'design', (select ama from ids) from made;
select t.ok((select count(*) from job_files) = 1, 'client can attach a design file to her draft');
select t.throws($$insert into job_files (org_id, job_id, storage_path, filename, size_bytes, kind, uploaded_by) select (select org_a from ids), job_id, 'x/y/b.pdf', 'b.pdf', 10, 'deliverable', (select ama from ids) from made$$, 'row-level security');
select t.throws($$insert into job_files (org_id, job_id, storage_path, filename, size_bytes, kind, uploaded_by) select (select org_a from ids), job_id, 'x/y/c.pdf', 'c.pdf', 99999999, 'design', (select ama from ids) from made$$, 'check constraint');
select t.throws($$insert into job_files (org_id, job_id, storage_path, filename, size_bytes, kind, uploaded_by) select (select org_a from ids), id, 'x/y/d.pdf', 'd.pdf', 10, 'design', (select ama from ids) from jobs where job_ref = 'JOB-2026-0002'$$, 'row-level security');
select t.throws($$insert into job_files (org_id, job_id, storage_path, filename, size_bytes, kind, uploaded_by) select (select org_a from ids), job_id, 'x/y/e.pdf', 'e.pdf', 10, 'design', (select kofi from ids) from made$$, 'row-level security');

update made set ref = submit_job(job_id);
select t.ok((select ref from made) = 'JOB-' || extract(year from now())::int || '-0005', 'submit assigns the next sequential reference');
select t.ok((select status from jobs where id = (select job_id from made)) = 'submitted', 'job is now submitted');
select t.ok((select count(*) from notifications where type = 'job_submitted') = 1, 'client was notified of submission');
select t.ok((select count(*) from client_job_timeline where job_id = (select job_id from made)) = 1, 'timeline has the submission entry');
select t.throws($$select submit_job((select job_id from made))$$, 'not_a_draft');
select t.throws($$select save_job_draft((select org_a from ids), (select job_id from made), jsonb_build_object('title','Sneaky edit','category_id',(select id from service_categories limit 1),'items','[{"description":"abc","quantity":1}]'::jsonb))$$, 'draft_not_found');
select t.throws($$select delete_job_draft((select job_id from made))$$, 'draft_not_found');

-- due date in the past cannot be submitted
create temp table old_draft (job_id uuid);
grant all on old_draft to authenticated;
insert into old_draft select save_job_draft((select org_a from ids), null,
  jsonb_build_object('title', 'Old job', 'category_id', (select id from service_categories limit 1), 'due_date', (current_date - 2)::text,
    'items', '[{"description":"Leaflets","quantity":10}]'::jsonb));
select t.throws($$select submit_job((select job_id from old_draft))$$, 'due_date_in_past');
select delete_job_draft((select job_id from old_draft));
select t.ok((select count(*) from jobs) = 4, 'client can delete her own draft');

-- cross-business writes
select t.throws($$select save_job_draft((select id from organisations where slug = 'other-press'), null, jsonb_build_object('title','Wrong tenant','category_id',(select id from service_categories limit 1),'items','[{"description":"abc","quantity":1}]'::jsonb))$$, 'not_a_customer');
reset role;

-- ---------------------------------------------------------------- client B (Kofi) in the same business
select t.login((select kofi from ids));
set role authenticated;
select t.ok((select count(*) from jobs) = 1, 'Kofi sees only his own job');
select t.ok((select count(*) from job_files) = 0, 'Kofi cannot see Ama''s files');
select t.throws($$select submit_job((select id from jobs where false union all select (select job_id from made)))$$, 'job_not_found');
reset role;

-- ---------------------------------------------------------------- other business (tenant isolation)
select t.login('00000000-0000-4000-8000-0000000000b1');
set role authenticated;
select t.ok((select count(*) from jobs) = 0, 'another business''s client sees none of our jobs');
select t.ok((select count(*) from organisations) = 1, 'other business client sees only their own business');
select t.ok((select count(*) from service_categories) = 8, 'other business sees only its own catalogue');
select t.throws($$select save_job_draft((select org_a from ids), null, jsonb_build_object('title','Cross tenant','category_id',(select id from service_categories limit 1),'items','[{"description":"abc","quantity":1}]'::jsonb))$$, 'not_a_customer');
create temp table b_job (job_id uuid);
grant all on b_job to authenticated;
insert into b_job select save_job_draft(
  (select id from organisations where slug = 'other-press'), null,
  jsonb_build_object('title', 'Other business job', 'category_id', (select id from service_categories limit 1),
    'items', '[{"description":"Posters","quantity":20}]'::jsonb));
select t.ok((select submit_job((select job_id from b_job))) = 'JOB-' || extract(year from now())::int || '-0001', 'each business has its own job number sequence');
reset role;

-- ---------------------------------------------------------------- staff
select t.login((select manager from ids));
set role authenticated;
select t.ok((select count(*) from jobs) = 5, 'manager sees all jobs in her business (and none from the other)');
select t.ok((select count(*) from jobs where title = 'Other business job') = 0, 'manager cannot see another business''s job');
select t.ok((select count(*) from job_status_history) = 13, 'manager can read full status history');
select t.ok((select count(*) from audit_logs) >= 1, 'manager can read the audit log');
select t.ok((select count(*) from customers) = 3, 'manager sees the business''s customers (Ama, Kofi and the sneaky test user)');
select t.ok((select count(*) from organisations) = 1, 'manager sees only her own business');
select t.throws($$update jobs set status = 'completed'$$, 'permission denied');
select t.throws($$select save_job_draft((select org_a from ids), null, jsonb_build_object('title','Staff cannot use client RPC','category_id',(select id from service_categories limit 1),'items','[{"description":"abc","quantity":1}]'::jsonb))$$, 'not_a_customer');
reset role;

-- ---------------------------------------------------------------- append-only records
select t.throws($$update job_status_history set client_note = 'edited'$$, 'append-only');
select t.throws($$delete from job_status_history$$, 'append-only');
select t.throws($$update audit_logs set action = 'edited'$$, 'append-only');
select t.throws($$delete from audit_logs$$, 'append-only');

-- ---------------------------------------------------------------- private file storage
select t.login((select ama from ids));
set role authenticated;
create temp table sj (id uuid);
grant all on sj to authenticated;
insert into sj select save_job_draft((select org_a from ids), null,
  jsonb_build_object('title', 'Storage test job', 'category_id', (select id from service_categories limit 1),
    'items', '[{"description":"Flyers","quantity":100}]'::jsonb));
insert into storage.objects (bucket_id, name, owner)
select 'job-files', (select org_a from ids)::text || '/' || id::text || '/art.pdf', (select ama from ids) from sj;
select t.ok((select count(*) from storage.objects) = 1, 'client can upload an allowed file type to her own job folder');
select t.throws($$insert into storage.objects (bucket_id, name, owner) select 'job-files', (select org_a from ids)::text || '/' || id::text || '/virus.exe', (select ama from ids) from sj$$, 'row-level security');
select t.throws($$insert into storage.objects (bucket_id, name, owner) select 'job-files', (select org_a from ids)::text || '/' || id::text || '/ARCHIVE.EXE', (select ama from ids) from sj$$, 'row-level security');
select t.throws($$insert into storage.objects (bucket_id, name, owner) select 'job-files', (select org_a from ids)::text || '/' || id::text || '/noextension', (select ama from ids) from sj$$, 'row-level security');
select t.throws($$insert into storage.objects (bucket_id, name, owner) select 'job-files', (select org_a from ids)::text || '/' || (select id from jobs where job_ref = 'JOB-2026-0004') || '/x.pdf', (select ama from ids)$$, 'row-level security');
select t.throws($$insert into storage.objects (bucket_id, name, owner) select 'job-files', (select id from organisations where slug = 'other-press')::text || '/' || id::text || '/x.pdf', (select ama from ids) from sj$$, 'row-level security');
select t.throws($$insert into storage.objects (bucket_id, name, owner) select 'public-bucket', (select org_a from ids)::text || '/' || id::text || '/x.pdf', (select ama from ids) from sj$$, 'row-level security');
reset role;

select t.login((select kofi from ids));
set role authenticated;
select t.ok((select count(*) from storage.objects) = 0, 'another client cannot list or read Ama''s files');
select t.throws($$select save_job_draft((select org_a from ids), (select id from sj), jsonb_build_object('title','Hijack attempt','category_id',(select id from service_categories limit 1),'items','[{"description":"abc","quantity":1}]'::jsonb))$$, 'draft_not_found');
select t.throws($$select delete_job_draft((select id from sj))$$, 'draft_not_found');
reset role;

select t.login((select manager from ids));
set role authenticated;
select t.ok((select count(*) from storage.objects) = 0, 'staff cannot read files on a client''s unsubmitted draft');
reset role;

select t.login('00000000-0000-4000-8000-0000000000b1');
set role authenticated;
select t.ok((select count(*) from storage.objects) = 0, 'another business cannot read our files');
reset role;

\echo
\echo ALL CHECKS PASSED
