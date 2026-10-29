-- Minimal stand-ins for the parts of Supabase our migrations rely on, so the SQL and the
-- Row Level Security rules can be tested on a plain PostgreSQL server (no Docker, no network).
-- NOT used on real Supabase, where these objects already exist.

create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon')          then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')  then create role service_role nologin bypassrls; end if;
end $$;

create schema if not exists auth;
create schema if not exists storage;

create table auth.users (
  instance_id uuid, id uuid primary key, aud text, role text, email text, encrypted_password text,
  email_confirmed_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb,
  created_at timestamptz, updated_at timestamptz,
  confirmation_token text, recovery_token text, email_change text, email_change_token_new text
);
create table auth.identities (
  id uuid primary key, user_id uuid references auth.users (id) on delete cascade, identity_data jsonb,
  provider text, provider_id text, last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz,
  unique (provider, provider_id)
);

create function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create table storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint);
create table storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id),
  name text, owner uuid, created_at timestamptz default now()
);
alter table storage.objects enable row level security;

create function storage.foldername(name text) returns text[] language sql immutable as
$$ select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)] $$;
create function storage.extension(name text) returns text language sql immutable as
$$ select substring(name from '\.([^.]*)$') $$;

grant usage on schema public, auth, storage to anon, authenticated, service_role;
grant execute on function auth.uid(), storage.foldername(text), storage.extension(text) to anon, authenticated;
grant select, insert, delete on storage.objects to authenticated;
grant select on storage.buckets to authenticated;

-- Supabase hands every new public table/function to the API roles by default; mimic that so the
-- migration's explicit REVOKE/GRANT section is genuinely exercised.
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
