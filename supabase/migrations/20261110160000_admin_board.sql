-- Owner board staging and overseer history.
-- Apply in the Supabase SQL editor. The site build does not apply this file.
-- The bucket and tables have no browser policies. The server uses the service role.

insert into storage.buckets (id, name, public, file_size_limit)
values ('admin-staging', 'admin-staging', false, 5242880)
on conflict (id) do nothing;

create table if not exists public.admin_uploads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  path text not null,
  bytes integer not null,
  content_type text not null default '',
  created_at timestamptz not null default now()
);

alter table public.admin_uploads enable row level security;

create table if not exists public.overseer_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  deploy_failed boolean not null default false,
  rollback_recommended boolean not null default false,
  report jsonb not null
);

alter table public.overseer_runs enable row level security;
