-- Pass 4 QA: objective coverage metrics + speech_coverage column; drop speech_fit

alter table public.quality_scores
  add column if not exists speech_coverage integer;

alter table public.quality_scores
  add column if not exists coverage_metrics jsonb;

alter table public.quality_scores
  drop column if exists speech_fit;
