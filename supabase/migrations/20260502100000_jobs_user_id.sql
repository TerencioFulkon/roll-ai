alter table public.jobs add column if not exists user_id uuid references auth.users (id);

create index if not exists jobs_user_id_idx on public.jobs (user_id);
