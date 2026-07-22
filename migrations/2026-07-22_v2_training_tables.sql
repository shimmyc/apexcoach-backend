-- ============================================================================
-- ENGINE v2 · PHASE 2  ·  training_blocks + planned_sessions
-- ============================================================================
-- WHAT THIS DOES
--   Creates the two new tables the v2 planner writes: a persisted training
--   block (the weekly reconciliation of goals/tiers/schedule/phase emphasis)
--   and the concrete planned sessions that hang off it.
--
-- STATUS: **NOT RUN.** Written by Claude Code, executed manually by Shimmy in
--   the Supabase SQL editor. Never assume it has been run.
--
-- PREREQUISITES
--   * None beyond an existing `profiles` table.
--   * Nothing in Engine v2 Phase 2 READS these tables yet — the progression
--     builder, dossier builder and the /api/v2/audit endpoint all work without
--     them. They are needed from Phase 3 (planner) onward. Applying this early
--     is safe and inert.
--
-- ISOLATION
--   * Creates new tables only. Touches no existing table, column, index or
--     policy. Profile 1's v1 path cannot observe this migration.
--   * RLS + `service_role_bypass` on both, matching the convention used by the
--     other 16 tables (the backend authenticates with the service key, so RLS
--     is transparent to the app and no query changes are needed).
-- ============================================================================


-- ── training_blocks ─────────────────────────────────────────────────────────
-- One row per planned block per profile. `status` is intentionally small:
--   active      — the block the planner is currently working from
--   completed   — ran its course
--   superseded  — replaced by a re-plan before it finished (driver-goal change,
--                 >=3 consecutive missed sessions, explicit user request)
-- `block` jsonb carries: focus, driver goals, phase note, weekly structure
-- rationale, tradeoff notes. Kept as jsonb because its shape is still settling
-- and nothing queries inside it.
CREATE TABLE IF NOT EXISTS training_blocks (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  profile_id  bigint NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status      text   NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','completed','superseded')),
  start_date  date   NOT NULL,
  end_date    date,
  block       jsonb  NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_training_blocks_profile_status
  ON training_blocks(profile_id, status);

-- At most one active block per profile. Partial unique index rather than a
-- table constraint so completed/superseded rows accumulate freely as history.
CREATE UNIQUE INDEX IF NOT EXISTS idx_training_blocks_one_active
  ON training_blocks(profile_id)
  WHERE status = 'active';


-- ── planned_sessions ────────────────────────────────────────────────────────
-- `slot` allows multiple sessions on one date (an anchored class plus an
-- accessory bolt-on) while still giving the planner and the code resequencer a
-- stable idempotency key.
--
-- `status`:
--   planned | completed | missed | modified | skipped
--     modified = the autoregulator changed it from what the planner wrote
--     skipped  = deliberately dropped (by the athlete or the resequencer)
--     missed   = the date passed with nothing logged
--
-- `priority` drives the resequencer's drop order when a week cannot fit.
-- `movable` marks a session the resequencer may relocate (an anchored class is
-- movable = false).
--
-- `workout_id` links a completed session back to the actual logged workout.
-- ON DELETE SET NULL, not CASCADE: deleting a logged workout must not erase the
-- record that the session was planned.
CREATE TABLE IF NOT EXISTS planned_sessions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  profile_id  bigint NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  block_id    bigint REFERENCES training_blocks(id) ON DELETE CASCADE,
  date        date   NOT NULL,
  slot        int    NOT NULL DEFAULT 1,
  status      text   NOT NULL DEFAULT 'planned'
                     CHECK (status IN ('planned','completed','missed','modified','skipped')),
  priority    int    NOT NULL DEFAULT 100,
  movable     boolean NOT NULL DEFAULT true,
  session     jsonb  NOT NULL DEFAULT '{}'::jsonb,
  workout_id  bigint REFERENCES workouts(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT planned_sessions_profile_date_slot_key UNIQUE (profile_id, date, slot)
);

CREATE INDEX IF NOT EXISTS idx_planned_sessions_profile_date
  ON planned_sessions(profile_id, date);

CREATE INDEX IF NOT EXISTS idx_planned_sessions_block
  ON planned_sessions(block_id);


-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Same shape as every other table in this project: RLS on, one
-- service_role_bypass policy. The backend uses the Supabase SERVICE key, so
-- this is transparent to the app; it closes public anon-key access.
ALTER TABLE training_blocks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_bypass ON training_blocks;
CREATE POLICY service_role_bypass ON training_blocks
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE planned_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_bypass ON planned_sessions;
CREATE POLICY service_role_bypass ON planned_sessions
  FOR ALL TO service_role USING (true) WITH CHECK (true);


-- ── Post-run check (read-only) ──────────────────────────────────────────────
SELECT c.relname                                   AS table_name,
       c.relrowsecurity                            AS rls_enabled,
       (SELECT count(*) FROM pg_policies p
         WHERE p.schemaname = 'public'
           AND p.tablename = c.relname
           AND p.policyname = 'service_role_bypass') AS bypass_policies
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('training_blocks','planned_sessions')
ORDER BY c.relname;
-- Both rows must read rls_enabled = true, bypass_policies = 1.
