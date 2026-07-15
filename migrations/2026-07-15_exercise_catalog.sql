-- Exercise canonicalization catalog (2026-07-15).
--
-- Generalizes the hand-fixed Dead Hang alias handling (CANONICAL_NAMES in
-- server.js, the 2026-05-09 Dead Hang canonicalization migration) into a
-- catalog-backed system so every logged exercise resolves to one canonical
-- identity, ending "push up / push-up / pushups / Push Ups" fragmentation
-- in history, analytics, and micro-goal tracking.
--
-- family / muscle_groups_primary / muscle_groups_secondary are populated
-- now (from the CANONICAL_NAMES seed below, and later from the MuscleWiki
-- bulk-seed) but only CONSUMED starting phase 2 (Library rollups / muscle
-- filtering) — baked in now so phase 2 needs no further migration.
--
-- Run once in the Supabase SQL editor.

CREATE TABLE IF NOT EXISTS exercise_catalog (
  id bigint generated always as identity primary key,
  canonical_name text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  family text,
  muscle_groups_primary text[] NOT NULL DEFAULT '{}',
  muscle_groups_secondary text[] NOT NULL DEFAULT '{}',
  equipment text[] NOT NULL DEFAULT '{}',
  -- Matches exercises.main_category's actual stored taxonomy (see
  -- "Workout Taxonomy" in CLAUDE.md): strength/cardio/martial_arts/sports/
  -- mind_body/rehab/other. NOT the AI extraction prompt's pre-normalization
  -- enum (strength/combat/cardio/mobility/rehab/core/other) — that gets
  -- mapped to this one by normalizeCategory() before anything reaches here.
  category text CHECK (category IN ('strength', 'cardio', 'martial_arts', 'sports', 'mind_body', 'rehab', 'other')),
  is_duration_based boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'custom' CHECK (source IN ('musclewiki', 'custom')),
  musclewiki_id text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (canonical_name)
);

CREATE INDEX IF NOT EXISTS idx_exercise_catalog_aliases ON exercise_catalog USING gin (aliases);
CREATE UNIQUE INDEX IF NOT EXISTS idx_exercise_catalog_musclewiki_id ON exercise_catalog (musclewiki_id) WHERE musclewiki_id IS NOT NULL;

ALTER TABLE exercise_catalog ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_bypass ON exercise_catalog;
CREATE POLICY service_role_bypass ON exercise_catalog
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Seed FROM the existing CANONICAL_NAMES map (server.js, ~line 2873) rather
-- than duplicating it independently — this is the "integrate with the
-- existing system" step: every alias group below is transcribed directly
-- from that map, grouped by target. These rows exist so the very first save
-- after this migration runs exact-matches instantly (no fuzzy/Haiku chip)
-- for every exercise the app already knew how to canonicalize, and so a
-- later MuscleWiki bulk-seed upsert can detect these as already-covered
-- (by canonical_name or alias) instead of creating a colliding duplicate
-- with a different capitalization/spelling (e.g. MuscleWiki's "Push Up" vs
-- this app's established "Push-Up").
INSERT INTO exercise_catalog (canonical_name, aliases, category, is_duration_based, source) VALUES
  ('Cat-Cow', ARRAY['cat and cow','cat cow','cat-cows'], 'rehab', false, 'custom'),
  ('Windshield Wiper', ARRAY['windshield wipers'], 'strength', false, 'custom'),
  ('Glute Bridge', ARRAY['glute bridges'], 'rehab', false, 'custom'),
  ('Clamshell', ARRAY['clam shell','clamshells'], 'rehab', false, 'custom'),
  ('Push-Up', ARRAY['push up','pushup','push ups','pushups','push-ups'], 'strength', false, 'custom'),
  ('Dead Bug', ARRAY['dead bugs'], 'rehab', false, 'custom'),
  ('Hip Flexor Stretch', ARRAY['hip flexor stretches'], 'rehab', false, 'custom'),
  ('Dumbbell Row', ARRAY['dumbbell rows'], 'strength', false, 'custom'),
  ('Bicep Curl', ARRAY['bicep curls','dumbbell bicep curl','dumbbell bicep curls'], 'strength', false, 'custom'),
  ('Bird Dog', ARRAY['bird dogs'], 'rehab', false, 'custom'),
  ('Plank', ARRAY['planks'], 'strength', true, 'custom'),
  ('Squat', ARRAY['squats'], 'strength', false, 'custom'),
  ('Lunge', ARRAY['lunges'], 'strength', false, 'custom'),
  ('Burpee', ARRAY['burpees'], 'cardio', false, 'custom'),
  ('Sit-Up', ARRAY['sit up','sit ups','situp','situps'], 'strength', false, 'custom'),
  ('Pull-Up', ARRAY['pull up','pull ups','pullup','pullups'], 'strength', false, 'custom'),
  ('Chin-Up', ARRAY['chin up','chin ups','chinup','chinups'], 'strength', false, 'custom'),
  ('Dead Hang', ARRAY['hang','hangs','dead hangs','hanging','bar hang','bar hangs','passive hang','passive hangs'], 'strength', true, 'custom')
ON CONFLICT (canonical_name) DO NOTHING;
