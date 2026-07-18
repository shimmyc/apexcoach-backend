-- Exercise variations (session #27, 2026-07-18)
-- Mirrors wger's OWN data model: each wger exerciseinfo item carries a
-- `variation_group` UUID; all exercises sharing that UUID are variants of one
-- another. We store that group key verbatim (NOT a denormalized id-array) so
-- "variations of X" is resolved at READ time by a self-filter:
--   WHERE variation_group = <X> AND id <> <self> AND variation_group IS NOT NULL
-- This self-heals across the session-#25/#8 merges/renames/deletes — a row that
-- gets merged or removed simply drops out of its group with zero array upkeep,
-- and read-time resolution always reflects the CURRENT catalog (no dead links).
--
-- Nullable: only wger-sourced (or wger-merged) rows ever get a value; the ~74
-- non-wger custom/CANONICAL_NAMES rows stay null (no variation data → no
-- section, correct). Seeded by POST /api/debug/seed-exercise-variations,
-- matched by wger_id (UPDATE-only, fill-if-null), same discipline as the
-- description/images content seed. Run this migration manually in Supabase
-- (same as every prior exercise_catalog migration), then run the seed.

ALTER TABLE exercise_catalog ADD COLUMN IF NOT EXISTS variation_group text;

-- Index for the read-time sibling lookup (partial — the majority of rows are
-- null and never queried).
CREATE INDEX IF NOT EXISTS idx_exercise_catalog_variation_group
  ON exercise_catalog (variation_group)
  WHERE variation_group IS NOT NULL;

-- Column-add only on an existing RLS-enabled table — no policy changes needed
-- (nothing to reassert), consistent with the wger_id / content migrations.
