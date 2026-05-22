-- Unmatched Fitbit Activities card — dismissal storage
-- Run once in the Supabase SQL editor.
--
-- The Today-tab "Unmatched Fitbit Activities" card lets the user dismiss a
-- Fitbit session so it never reappears. A dismissal is global (not tied to a
-- specific workout), but rejected_wearable_matches.workout_id is NOT NULL, so
-- we can't record it there. Instead we keep an array of namespaced
-- "fitbit:<activityId>" strings on the profile.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS dismissed_fitbit_activities jsonb DEFAULT '[]'::jsonb;
