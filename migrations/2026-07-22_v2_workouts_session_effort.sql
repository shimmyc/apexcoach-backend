-- ============================================================================
-- ENGINE v2 · PHASE 2  ·  workouts.session_effort (RIR-lite effort feedback)
-- ============================================================================
-- WHAT THIS DOES
--   Adds one nullable text column to `workouts` recording the athlete's
--   one-tap post-save effort answer:
--     'more_in_tank' | 'about_right' | 'brutal'
--   NULL means the athlete skipped it, which is a first-class outcome — the
--   prompt says the question is skippable, so NULL must stay legal and must
--   never be inferred as 'about_right'.
--
--   Consumed by the progression rules: `more_in_tank` on 2 consecutive sessions
--   of a lift -> progress it; `brutal` -> hold or reduce.
--
-- STATUS: **NOT RUN.** Written by Claude Code, executed manually by Shimmy in
--   the Supabase SQL editor. Never assume it has been run.
--
-- PREREQUISITES
--   None. Column add only.
--
-- NO ENDPOINT CHANGE IS NEEDED — verified, not assumed.
--   `POST /api/workouts` (server.js:2423) and `PATCH /api/workouts/:id` both
--   forward `req.body` VERBATIM to PostgREST with no field whitelist. So the
--   moment this column exists, a client can write `session_effort` through the
--   existing endpoints with zero server change. The only work left for Phase 6
--   is the one-tap UI, gated on the engine_v2 flag.
--
--   ⚠ Corollary worth stating plainly: because those endpoints are
--   pass-through, ANY client could already write ANY column on `workouts`.
--   That is pre-existing behavior, not something this migration introduces —
--   but it is why the CHECK constraint below matters. It is the only thing
--   preventing a typo'd or hostile value from landing in the column.
--
-- ISOLATION
--   `workouts` is shared with v1/profile 1, so this is the one migration in
--   Phase 2 that touches an existing table. It is additive and nullable:
--   every existing row gets NULL, no existing query selects the column
--   (`/api/workouts/:id/full` uses `select=*` and will simply start returning
--   an extra null field, which no client reads), and no v1 write path sets it.
-- ============================================================================

ALTER TABLE workouts
  ADD COLUMN IF NOT EXISTS session_effort text;

-- Separate statement so re-running the file is safe even if the column already
-- exists from a partial run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workouts_session_effort_check'
      AND conrelid = 'public.workouts'::regclass
  ) THEN
    ALTER TABLE workouts
      ADD CONSTRAINT workouts_session_effort_check
      CHECK (session_effort IS NULL
             OR session_effort IN ('more_in_tank','about_right','brutal'));
  END IF;
END $$;


-- ── Post-run check (read-only) ──────────────────────────────────────────────
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'workouts' AND column_name = 'session_effort';

SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.workouts'::regclass
  AND conname = 'workouts_session_effort_check';

-- Every existing row must be NULL — nothing backfills this.
SELECT count(*) AS total_workouts,
       count(session_effort) AS with_effort_should_be_zero
FROM workouts;
