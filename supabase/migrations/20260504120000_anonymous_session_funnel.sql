-- Anonymous onboarding funnel flags (paired with jobs.session_id, stored as UUID text).
-- No RLS — access is controlled by application logic (session UUID secrecy), matching the jobs table.

create table if not exists public.anonymous_session_funnel (
  session_id text primary key,
  first_watch_nudge_shown_at timestamptz,
  pending_signup_gate_job_id uuid references public.jobs (sqlid) on delete set null,
  updated_at timestamptz not null default now()
);

create index if not exists anonymous_session_funnel_pending_job_idx on public.anonymous_session_funnel (pending_signup_gate_job_id);

grant all on table public.anonymous_session_funnel to service_role;
grant all on table public.anonymous_session_funnel to authenticated;
grant all on table public.anonymous_session_funnel to anon;
