-- Private bucket for encrypted overseer snapshots. No browser policy.
-- Apply in the Supabase SQL editor. The site build does not apply this file.

insert into storage.buckets (id, name, public, file_size_limit)
values ('overseer-backups', 'overseer-backups', false, 5242880)
on conflict (id) do nothing;
