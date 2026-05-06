-- Extended LLM pass cost breakdown (narration plan, script, QA) + narrative coherence QA sub-score.

alter table public.usage_logs
  add column if not exists pass3_prompt_tokens integer not null default 0;

alter table public.usage_logs
  add column if not exists pass3_completion_tokens integer not null default 0;

alter table public.usage_logs
  add column if not exists pass3_cost_usd numeric(10, 6) not null default 0;

alter table public.usage_logs
  add column if not exists pass4_prompt_tokens integer not null default 0;

alter table public.usage_logs
  add column if not exists pass4_completion_tokens integer not null default 0;

alter table public.usage_logs
  add column if not exists pass4_cost_usd numeric(10, 6) not null default 0;

alter table public.usage_logs
  add column if not exists pass5_prompt_tokens integer not null default 0;

alter table public.usage_logs
  add column if not exists pass5_completion_tokens integer not null default 0;

alter table public.usage_logs
  add column if not exists pass5_cost_usd numeric(10, 6) not null default 0;

-- Pass 5 in usage_logs = QA scoring LLM (post-roll review "Pass 7" in pipeline docs).

alter table public.quality_scores
  add column if not exists narrative_coherence integer;
