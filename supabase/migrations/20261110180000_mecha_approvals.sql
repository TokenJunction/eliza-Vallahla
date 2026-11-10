-- Pending Mecha approvals. The server writes them. The browser does not execute them.
-- Apply in the Supabase SQL editor. The site build does not apply this file.

create table if not exists public.mecha_approvals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('merge', 'money', 'dns', 'post', 'trade')),
  mecha text not null,
  task text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now()
);

alter table public.mecha_approvals enable row level security;

drop policy if exists mecha_approvals_own on public.mecha_approvals;
create policy mecha_approvals_own
  on public.mecha_approvals
  for select
  to authenticated
  using (auth.uid() = user_id);
