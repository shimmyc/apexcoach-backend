-- Athlete timezone storage, fixing a recurring UTC-vs-local-day bug class
-- (Coach Chat's "today" mislabeling a same-day workout, and the earlier
-- Google Health daily-sync date-keying issue were both symptoms of the same
-- root cause: server-side "today" was always computed from the server's own
-- clock/OS timezone, never the athlete's). Nullable, no default — existing
-- profiles fall back to UTC in localToday() until the client captures a
-- real value on next boot, so this migration alone changes no behavior.
-- Run manually in the Supabase SQL editor.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS timezone text;
