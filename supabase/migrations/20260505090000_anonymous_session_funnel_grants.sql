-- Grant PostgREST roles access to anonymous_session_funnel.
-- The table was created without grants (migration-applied, not dashboard-created),
-- so PostgREST returns "permission denied" for all roles including service_role.

grant all on table public.anonymous_session_funnel to service_role;
grant all on table public.anonymous_session_funnel to authenticated;
grant all on table public.anonymous_session_funnel to anon;
