create extension if not exists "pgcrypto";

create table if not exists public.jobs (
  sqlid uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  status text not null,
  input_url text,
  output_url text,
  error_message text,
  progress text,
  metadata jsonb,
  user_id uuid references auth.users (id),
  session_id text,
  constraint jobs_status_check check (
    status in (
      'pending',
      'uploading',
      'processing',
      'generating_audio',
      'stitching_video',
      'complete',
      'failed'
    )
  )
);

create index if not exists jobs_status_idx on public.jobs (status);
create index if not exists jobs_created_at_idx on public.jobs (created_at);
create index if not exists jobs_user_id_idx on public.jobs (user_id);

create index if not exists jobs_session_id_idx on public.jobs (session_id);

create table if not exists public.usage_logs (
  id uuid primary key default gen_random_uuid (),
  job_id uuid not null references public.jobs (sqlid) on delete cascade,
  created_at timestamptz not null default now (),
  pass1_prompt_tokens integer not null default 0,
  pass1_completion_tokens integer not null default 0,
  pass1_cost_usd numeric(10, 6) not null default 0,
  pass2_prompt_tokens integer not null default 0,
  pass2_completion_tokens integer not null default 0,
  pass2_cost_usd numeric(10, 6) not null default 0,
  pass3_prompt_tokens integer not null default 0,
  pass3_completion_tokens integer not null default 0,
  pass3_cost_usd numeric(10, 6) not null default 0,
  pass4_prompt_tokens integer not null default 0,
  pass4_completion_tokens integer not null default 0,
  pass4_cost_usd numeric(10, 6) not null default 0,
  pass5_prompt_tokens integer not null default 0,
  pass5_completion_tokens integer not null default 0,
  pass5_cost_usd numeric(10, 6) not null default 0,
  tts_characters integer not null default 0,
  tts_cost_usd numeric(10, 6) not null default 0,
  total_cost_usd numeric(10, 6) not null default 0,
  voice_key text,
  video_duration_seconds numeric(8, 2),
  provider text
);

create index if not exists usage_logs_job_id_idx on public.usage_logs (job_id);
create index if not exists usage_logs_created_at_idx on public.usage_logs (created_at desc);

create table if not exists public.quality_scores (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs (sqlid) on delete cascade,
  created_at timestamptz not null default now(),
  analysis_quality_score numeric(4, 1),
  visual_accuracy integer,
  coaching_usefulness integer,
  timing_accuracy integer,
  speech_coverage integer,
  output_compliance integer,
  narrative_coherence integer,
  main_issues jsonb,
  recommended_fix text,
  coverage_metrics jsonb
);

create index if not exists quality_scores_job_id_idx on public.quality_scores (job_id);

create table if not exists public.anonymous_session_funnel (
  session_id text primary key,
  first_watch_nudge_shown_at timestamptz,
  three_roll_watch_nudge_shown_at timestamptz,
  pending_signup_gate_job_id uuid references public.jobs (sqlid) on delete set null,
  updated_at timestamptz not null default now()
);

create index if not exists anonymous_session_funnel_pending_job_idx on public.anonymous_session_funnel (pending_signup_gate_job_id);

insert into storage.buckets (id, name, public)
values
  ('input-videos', 'input-videos', false),
  ('output-videos', 'output-videos', false),
  ('temp-audio', 'temp-audio', false),
  ('profile-photos', 'profile-photos', false)
on conflict (id) do nothing;
