alter table public.jobs add column if not exists session_id text;

create index if not exists jobs_session_id_idx on public.jobs (session_id);
