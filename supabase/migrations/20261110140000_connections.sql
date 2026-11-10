-- Per-user API connections. Ciphertext is not selectable by the browser role.
-- Apply in the Supabase SQL editor. The site build does not apply this file.

create extension if not exists pgcrypto;

create table if not exists public.connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  service text not null check (service in ('openai', 'openrouter', 'helius', 'stripe')),
  base_url text not null default '',
  last4 text not null default '',
  ciphertext text not null,
  status text not null default 'saved',
  updated_at timestamptz not null default now()
);

alter table public.connections enable row level security;

drop policy if exists connections_own on public.connections;
create policy connections_own
  on public.connections
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

revoke all on public.connections from authenticated;
grant select (id, user_id, service, base_url, last4, status, updated_at) on public.connections to authenticated;
grant insert (user_id, service, base_url, last4, ciphertext, status) on public.connections to authenticated;
grant delete on public.connections to authenticated;

create table if not exists public.connection_packs (
  user_id uuid primary key references auth.users (id) on delete cascade,
  paper_only boolean not null default true,
  assistant boolean not null default false,
  status_board boolean not null default false
);

alter table public.connection_packs enable row level security;

drop policy if exists connection_packs_own on public.connection_packs;
create policy connection_packs_own
  on public.connection_packs
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create table if not exists public.valos_api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  last4 text not null,
  key_hash text not null,
  created_at timestamptz not null default now()
);

alter table public.valos_api_keys enable row level security;

drop policy if exists valos_api_keys_own on public.valos_api_keys;
create policy valos_api_keys_own
  on public.valos_api_keys
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

revoke all on public.valos_api_keys from authenticated;
grant select (id, user_id, last4, created_at) on public.valos_api_keys to authenticated;
grant insert (user_id, last4, key_hash) on public.valos_api_keys to authenticated;

create or replace function public.valos_key_status(raw text)
returns table (last4 text)
language sql
security definer
set search_path = public
as $$
  select k.last4
  from public.valos_api_keys as k
  where k.key_hash = encode(extensions.digest(convert_to(raw, 'utf8'), 'sha256'), 'hex')
  limit 1;
$$;

revoke all on function public.valos_key_status(text) from public;
grant execute on function public.valos_key_status(text) to anon, authenticated;

create or replace function public.connection_secret(row_id uuid)
returns text
language sql
security definer
set search_path = public
as $$
  select ciphertext
  from public.connections
  where id = row_id
    and user_id = auth.uid();
$$;

revoke all on function public.connection_secret(uuid) from public;
grant execute on function public.connection_secret(uuid) to authenticated;
