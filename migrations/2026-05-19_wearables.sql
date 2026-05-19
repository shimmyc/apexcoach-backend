-- Wearable-agnostic workout matching system
-- Run once in the Supabase SQL editor.
--
-- Two new tables + two columns on workouts so any wearable provider
-- (Fitbit / Google Health Connect / Apple Health / Samsung Health / Garmin)
-- can be wired in without further schema work.

-- 1. Per-workout wearable payload + dedupe key.
--    wearable_activity_id is namespaced as "provider:activity_id"
--    (e.g. "fitbit:abc123") so the same numeric activityId from two
--    different providers can never collide.
ALTER TABLE workouts
  ADD COLUMN IF NOT EXISTS wearable_data jsonb,
  ADD COLUMN IF NOT EXISTS wearable_activity_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workouts_wearable_activity_id
  ON workouts(wearable_activity_id)
  WHERE wearable_activity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workouts_profile_date
  ON workouts(profile_id, date);

-- 2. One row per (profile, provider) — stores OAuth tokens for every
--    connected wearable account. Token refresh writes back here.
CREATE TABLE IF NOT EXISTS wearable_connections (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  profile_id bigint NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  provider text NOT NULL,
  access_token text,
  refresh_token text,
  token_expires_at bigint,  -- epoch ms; matches the existing Fitbit storage convention
  last_synced_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(profile_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_wearable_conn_profile
  ON wearable_connections(profile_id);

-- 3. Records a user's "no, these are separate sessions" decision so the
--    same suggested pairing doesn't keep appearing on every backlog sync.
CREATE TABLE IF NOT EXISTS rejected_wearable_matches (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  profile_id bigint NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  workout_id bigint NOT NULL,
  provider text NOT NULL,
  wearable_activity_id text NOT NULL,  -- "provider:id" form, matches workouts.wearable_activity_id
  created_at timestamptz DEFAULT now(),
  UNIQUE(profile_id, workout_id, wearable_activity_id)
);

CREATE INDEX IF NOT EXISTS idx_rejected_matches_profile_activity
  ON rejected_wearable_matches(profile_id, wearable_activity_id);

-- 4. Backfill: copy any existing Fitbit tokens from the profiles table
--    into wearable_connections so the new adapter picks them up without
--    requiring users to reconnect. Profile-level fitbit_* columns stay
--    in place — the Fitbit adapter reads from wearable_connections first,
--    falls back to profiles.fitbit_* if the row is absent.
INSERT INTO wearable_connections (profile_id, provider, access_token, refresh_token, token_expires_at, created_at, updated_at)
SELECT
  id,
  'fitbit',
  fitbit_access_token,
  fitbit_refresh_token,
  fitbit_expires_at,
  COALESCE(created_at, now()),
  now()
FROM profiles
WHERE fitbit_access_token IS NOT NULL
  AND fitbit_access_token <> ''
ON CONFLICT (profile_id, provider) DO NOTHING;
