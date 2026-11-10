-- Stripe Pro entitlement. A user can read only their own row.
-- The webhook writes with the service role, which bypasses row level security.
-- Apply in the Supabase SQL editor. The site build does not apply this file.

create table if not exists public.entitlements (
  id uuid primary key references auth.users (id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'pro', 'unlimited')),
  status text not null default 'inactive',
  trial_used boolean not null default false,
  needs_card boolean not null default false,
  stripe_customer_id text,
  stripe_subscription_id text,
  updated_at timestamptz not null default now()
);

alter table public.entitlements enable row level security;

drop policy if exists entitlements_select_own on public.entitlements;
create policy entitlements_select_own
  on public.entitlements
  for select
  to authenticated
  using (auth.uid() = id);
