-- Third-roll watch nudge (build-your-game sheet variant after three completed rolls).

alter table public.anonymous_session_funnel
  add column if not exists three_roll_watch_nudge_shown_at timestamptz;
