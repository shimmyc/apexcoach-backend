-- Daily sleep persistence (Life OS fast-path)
-- Run once in the Supabase SQL editor.
--
-- Stores last night's sleep per profile per day: hours, the COMPUTED personal
-- sleep score (estimateSleepScore — NOT Fitbit's own score), the stage-minute
-- breakdown, and the morning HRV/RHR snapshot. Upserted nightly from the Fitbit
-- sync (GET /api/profiles/:id/daily) and on the life-os-summary fallback path.
--
-- GET /api/profiles/:id/life-os-summary reads this first (WHERE profile_id AND
-- date = today) and returns it instantly with no live Fitbit call, so Life OS
-- keeps fast, reliable sleep/HRV/RHR after the first successful sync each day —
-- regardless of Render cold starts or Vercel timeouts.

CREATE TABLE IF NOT EXISTS daily_sleep (
  id bigint generated always as identity primary key,
  profile_id bigint references profiles(id) on delete cascade,
  date date not null,
  hours numeric(4,2),
  score int,
  deep_minutes int,
  rem_minutes int,
  light_minutes int,
  wake_minutes int,
  hrv numeric(6,2),
  rhr int,
  source text default 'fitbit',
  created_at timestamptz default now(),
  UNIQUE(profile_id, date)
);

CREATE INDEX IF NOT EXISTS idx_daily_sleep_profile_date ON daily_sleep(profile_id, date DESC);
