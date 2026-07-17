-- Drops the deprecated fitbit_pending_imports queue column (ROADMAP.md §9).
--
-- Confirmed nothing writes or reads it as of this migration: the daily sync
-- stopped calling diffAndQueueFitbitImports() on 2026-05-22 (replaced by the
-- Today-tab "Unmatched Fitbit Activities" card, GET /api/profiles/:id/unmatched-fitbit),
-- and diffAndQueueFitbitImports() / GET .../fitbit-pending-imports /
-- POST .../fitbit-import were removed entirely from server.js on 2026-07-17
-- (zero call sites confirmed by grep before removal).
--
-- Run any time after the server-side endpoint removal has deployed.

ALTER TABLE profiles DROP COLUMN IF EXISTS fitbit_pending_imports;
