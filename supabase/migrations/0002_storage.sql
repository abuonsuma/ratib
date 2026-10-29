-- Private bucket for job files. Path convention: {org_id}/{job_id}/{uuid}-{filename}
-- Browsers never get public URLs; downloads use short-lived signed URLs created on the server.

insert into storage.buckets (id, name, public, file_size_limit)
values ('job-files', 'job-files', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

-- allowed extensions (print files often arrive as application/octet-stream, so we check the extension)
create or replace function job_file_extension_ok(p_name text) returns boolean
language sql immutable as $$
  select lower(storage.extension(p_name)) in
    ('pdf','jpg','jpeg','png','tif','tiff','svg','ai','eps','psd','cdr','indd','zip','doc','docx','xls','xlsx','ppt','pptx','txt');
$$;

create policy job_files_upload on storage.objects for insert to authenticated
with check (
  bucket_id = 'job-files'
  and job_file_extension_ok(name)
  and exists (
    select 1 from public.jobs j
    where j.id::text = (storage.foldername(name))[2]
      and j.org_id::text = (storage.foldername(name))[1]
      and j.customer_id in (select public.my_customer_ids())
      and j.status in ('draft', 'submitted', 'under_review')
  )
);

-- reading is allowed when the job itself is visible to the user (jobs RLS applies inside the sub-select)
create policy job_files_read on storage.objects for select to authenticated
using (
  bucket_id = 'job-files'
  and exists (select 1 from public.jobs j where j.id::text = (storage.foldername(name))[2])
);

create policy job_files_remove on storage.objects for delete to authenticated
using (
  bucket_id = 'job-files'
  and owner = auth.uid()
  and exists (
    select 1 from public.jobs j
    where j.id::text = (storage.foldername(name))[2] and j.status = 'draft'
      and j.customer_id in (select public.my_customer_ids())
  )
);
