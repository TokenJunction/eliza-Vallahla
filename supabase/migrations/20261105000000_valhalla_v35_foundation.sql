create extension if not exists vector with schema extensions;

create table if not exists public.private_user_agents (
  user_id uuid primary key references auth.users (id) on delete cascade,
  agent_name text not null default 'Gorgo',
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint private_user_agents_no_credentials check (
    not (settings ?| array['apiKey', 'privateKey', 'secret', 'seedPhrase', 'token'])
  )
);

create table if not exists public.user_circuit_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  tripped boolean not null default false,
  reason text,
  updated_at timestamptz not null default now()
);

create table if not exists public.user_risk_limits (
  user_id uuid primary key references auth.users (id) on delete cascade,
  max_position_sol numeric(18, 9) not null default 0.1 check (max_position_sol > 0),
  max_trade_risk_pct numeric(5, 2) not null default 2 check (max_trade_risk_pct > 0 and max_trade_risk_pct <= 2),
  max_daily_drawdown_pct numeric(5, 2) not null default 5 check (max_daily_drawdown_pct > 0 and max_daily_drawdown_pct <= 5),
  mode text not null default 'paper' check (mode = 'paper'),
  updated_at timestamptz not null default now()
);

create table if not exists public.trade_audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  occurred_at timestamptz not null default now(),
  event text not null,
  mode text not null default 'paper' check (mode = 'paper'),
  details jsonb not null default '{}'::jsonb,
  constraint trade_audit_log_no_signatures check (
    not (details ?| array['privateKey', 'seedPhrase', 'signature', 'transactionSignature'])
  )
);

create index if not exists trade_audit_log_user_time_idx
  on public.trade_audit_log (user_id, occurred_at desc);

create table if not exists public.cerberus_vault_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users (id) on delete set null,
  occurred_at timestamptz not null default now(),
  action text not null,
  outcome text not null check (outcome in ('blocked', 'authorized')),
  reason text not null,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.legal_acceptance_audit (
  user_id uuid not null references auth.users (id) on delete cascade,
  terms_version text not null,
  accepted_at timestamptz not null default now(),
  primary key (user_id, terms_version)
);

alter table public.private_user_agents enable row level security;
alter table public.user_circuit_state enable row level security;
alter table public.user_risk_limits enable row level security;
alter table public.trade_audit_log enable row level security;
alter table public.cerberus_vault_logs enable row level security;
alter table public.legal_acceptance_audit enable row level security;

drop policy if exists private_user_agents_owner on public.private_user_agents;
create policy private_user_agents_owner on public.private_user_agents
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists user_circuit_state_owner on public.user_circuit_state;
create policy user_circuit_state_owner on public.user_circuit_state
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists user_risk_limits_owner on public.user_risk_limits;
create policy user_risk_limits_owner on public.user_risk_limits
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists trade_audit_log_owner on public.trade_audit_log;
create policy trade_audit_log_owner on public.trade_audit_log
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists legal_acceptance_audit_owner on public.legal_acceptance_audit;
create policy legal_acceptance_audit_owner on public.legal_acceptance_audit
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all on public.cerberus_vault_logs from anon, authenticated;
revoke all on public.cerberus_vault_logs from public;
grant all on public.cerberus_vault_logs to service_role;
drop policy if exists cerberus_vault_logs_service on public.cerberus_vault_logs;
create policy cerberus_vault_logs_service on public.cerberus_vault_logs
  for all to service_role
  using (true)
  with check (true);

grant select, insert, update, delete on public.private_user_agents to authenticated;
grant select, insert, update, delete on public.user_circuit_state to authenticated;
grant select, insert, update, delete on public.user_risk_limits to authenticated;
grant select, insert on public.trade_audit_log to authenticated;
grant select, insert on public.legal_acceptance_audit to authenticated;
