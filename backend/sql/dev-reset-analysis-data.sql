-- DEV ONLY: destructive reset for local/test analysis data.
-- This clears analysis jobs, usage logs, quality scores, and anonymous session funnel data.
-- It does not delete auth users.
-- It does not delete files from Supabase Storage.
-- Run manually in the Supabase SQL Editor only when you want a clean test slate.

delete from public.quality_scores;
delete from public.usage_logs;
delete from public.jobs;
delete from public.anonymous_session_funnel;

-- If DELETE fails because of foreign key dependencies, use this instead:
-- truncate table
--   public.quality_scores,
--   public.usage_logs,
--   public.jobs,
--   public.anonymous_session_funnel
-- restart identity cascade;
