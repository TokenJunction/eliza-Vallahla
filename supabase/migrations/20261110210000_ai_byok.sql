-- Customer bring-your-own key. Ciphertext is AES-256-GCM and is not readable by the browser role.
-- Apply in the Supabase SQL editor. The site build does not apply this file.

create table if not exists public.ai_byok (
  user_id uuid primary key references auth.users (id) on delete cascade,
  provider text not null check (provider in ('openai', 'openrouter')),
  ciphertext text not null,
  updated_at timestamptz not null default now()
);

alter table public.ai_byok enable row level security;

revoke all on public.ai_byok from anon, authenticated;
