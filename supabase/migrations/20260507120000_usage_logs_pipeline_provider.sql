-- Pass 1 visual timeline backend identification (openai | gemini) for cost attribution.

alter table public.usage_logs
  add column if not exists provider text;
