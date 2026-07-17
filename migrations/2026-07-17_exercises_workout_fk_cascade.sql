-- Adds a real FK from exercises.workout_id -> workouts.id, ON DELETE CASCADE
-- (ROADMAP.md §9). Makes the orphaned-exercises bug class (fixed in session
-- #11 for DELETE /api/workouts/:id) structurally impossible even if a future
-- code path deletes a workout some other way.
--
-- ⚠ RUN THE ORPHAN CHECK FIRST, FOR EVERY PROFILE. This ALTER TABLE fails if
-- any exercises.workout_id value doesn't match an existing workouts.id.
-- Profile 1 was cleaned in session #11 (27 rows removed) with none found
-- since. Profiles 4, 5, 7, and 8 have not been checked for this migration.
-- For each profile id:
--   GET  /api/debug/orphaned-exercises/:userId          (read-only report)
--   POST /api/debug/delete-orphaned-exercises/:userId   (body {ids:[...]})
-- Only run the ALTER TABLE below once every profile reports zero orphans.
--
-- Does not affect rows where workout_id IS NULL — extract-exercises can
-- insert a null workout_id (see server.js, POST /api/profiles/:id/extract-exercises),
-- and NULL FK values are always valid in Postgres regardless of any cascade.
-- DELETE /api/profiles/:id's own exercises cleanup (added 2026-07-17) stays
-- independent of this FK for exactly that reason — a cascade from workouts
-- can never reach a null-workout_id row.

ALTER TABLE exercises
  ADD CONSTRAINT exercises_workout_id_fkey
  FOREIGN KEY (workout_id) REFERENCES workouts(id)
  ON DELETE CASCADE;
