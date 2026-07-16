-- Add wger as a second catalog seed source (2026-07-16).
--
-- Replaces the never-run MuscleWiki bulk-seed (no API key ever existed for
-- it — see server.js's retired POST /api/debug/seed-exercise-catalog
-- comment history) with wger.de's free, keyless, CC-BY-SA public REST API.
-- musclewiki_id is kept as-is, unused for now, reserved for a future
-- MuscleWiki VIDEO-streaming layer (paid-user/beta stage — see ROADMAP.md
-- §7) that would do a one-time exercise-ID mapping pass onto this same
-- catalog, distinct from this session's data seed.
--
-- This migration only adds a column + widens a CHECK constraint on an
-- existing table — it does not touch RLS or policies, so nothing to
-- reassert (exercise_catalog's service_role_bypass policy, from
-- migrations/2026-07-15_exercise_catalog.sql, is untouched and still
-- covers every row regardless of source).
--
-- Run once in the Supabase SQL editor.

ALTER TABLE exercise_catalog ADD COLUMN IF NOT EXISTS wger_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_exercise_catalog_wger_id ON exercise_catalog (wger_id) WHERE wger_id IS NOT NULL;

-- Widen the source CHECK to admit 'wger' alongside the existing
-- 'musclewiki'/'custom' values. Postgres's default name for an unnamed
-- column CHECK is "<table>_<column>_check" — matches the original
-- migration's unnamed `source text ... CHECK (...)` column definition.
ALTER TABLE exercise_catalog DROP CONSTRAINT IF EXISTS exercise_catalog_source_check;
ALTER TABLE exercise_catalog ADD CONSTRAINT exercise_catalog_source_check CHECK (source IN ('musclewiki', 'custom', 'wger'));
