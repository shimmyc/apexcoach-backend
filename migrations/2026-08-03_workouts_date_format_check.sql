-- ============================================================================
-- CONSTRAINT: workouts.date must look like a date (session #47)
--
-- ⚠ RUN THIS **AFTER** 2026-08-03_repair_malformed_workout_dates.sql.
--   ADD CONSTRAINT validates every existing row, so it will FAIL outright while
--   any of the 8 malformed rows remain. That failure is the desired behaviour —
--   it is the same property that made the 2026-07-17 exercises FK migration's
--   success proof that no orphan existed.
--
-- ⚠ Written by the agent, run MANUALLY by Shimmy (ROADMAP §0.2 rule 3).
--
-- WHY A DB CONSTRAINT AND NOT ONLY CODE.
-- `workouts.date` is a `text` column, so Postgres has never rejected anything.
-- Three code paths insert workout rows, and session #47 added the shared
-- `isValidWorkoutDate()` guard to all three:
--   1. POST /api/workouts              (already guarded since 2026-07-15)
--   2. createWearableWorkout()         (UNGUARDED — this is what wrote the 8 rows)
--   3. POST /api/debug/seed-sandbox-workouts
-- But (2) existed for months writing straight to PostgREST, and the next direct
-- writer would be just as invisible. This constraint is the only guard that
-- cannot be bypassed by adding a new code path — belt to the code's braces.
--
-- SCOPE: format only. It deliberately does NOT enforce "not in the future" —
-- that rule is athlete-timezone-dependent (`localToday(profile)`), so it belongs
-- in application code where the timezone is known, not in a CHECK.
--
-- NOT NULL is deliberately NOT added: no current writer omits `date`, but adding
-- it would be a separate behavioural change and this migration should do one
-- thing. The CHECK is written so a NULL passes (SQL CHECK semantics), matching
-- today's tolerance.
-- ============================================================================


-- ── PRE-FLIGHT — must return 0. If it does not, STOP and run the repair first.
SELECT count(*) AS rows_that_would_fail_the_constraint
FROM workouts
WHERE date IS NOT NULL AND date !~ '^\d{4}-\d{2}-\d{2}$';


-- ── THE CONSTRAINT ────────────────────────────────────────────────────────
ALTER TABLE workouts
  ADD CONSTRAINT workouts_date_format_chk
  CHECK (date IS NULL OR date ~ '^\d{4}-\d{2}-\d{2}$');


-- ── CONFIRM ───────────────────────────────────────────────────────────────
-- Expect one row naming workouts_date_format_chk.
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'workouts'::regclass
  AND conname = 'workouts_date_format_chk';

-- Optional live proof it bites (expect: ERROR ... violates check constraint).
-- Uncomment to run, then ROLLBACK.
-- BEGIN;
--   INSERT INTO workouts (profile_id, date, type, notes, done, mobility, med, ts)
--   VALUES (1, '10:14', 'Constraint probe', 'should be rejected', false, false, false, 0);
-- ROLLBACK;


-- ── ROLLBACK (if ever needed) ─────────────────────────────────────────────
-- ALTER TABLE workouts DROP CONSTRAINT workouts_date_format_chk;
