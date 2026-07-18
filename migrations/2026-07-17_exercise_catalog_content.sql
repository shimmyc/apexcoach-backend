-- Exercise how-to content: description + images (2026-07-17).
-- Run once in the Supabase SQL editor.
--
-- Two nullable columns populated by POST /api/debug/seed-exercise-content
-- (fill-if-null) from wger.de's exerciseinfo API, keyed by the wger_id already
-- stored on ~805 rows. VIDEO is out of scope.
--   description — sanitized how-to HTML (strict allowlist: p/ul/ol/li/br/
--                 strong/b/em/i, all attributes + other tags stripped at seed
--                 time, so the value is safe to render with innerHTML later).
--   images      — jsonb array of { url, is_main, license_author }; wger URLs are
--                 hot-linked (not rehosted). CC-BY-SA attribution: the wger.de
--                 footer credit already exists; license_author is retained here
--                 for future per-image attribution.
-- NULL (the default) means "never populated" — the ~74 non-wger rows (no
-- wger_id) stay null and the detail view degrades gracefully.

ALTER TABLE exercise_catalog
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS images jsonb;
