-- Structured macro roadmap (replaces the free-text profiles.roadmap blob)
-- Run once in the Supabase SQL editor.
--
-- profiles.roadmap (text) + roadmap_updated_at are kept as legacy and are still
-- read/written by the existing /api/profiles/:id/roadmap endpoints (the current
-- client renders that markdown). The new structured macro roadmap lives in
-- roadmap_data (jsonb) and is served by /api/profiles/:id/roadmap-data. Nothing
-- in the new system writes the legacy text column.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS roadmap_data jsonb,
  ADD COLUMN IF NOT EXISTS roadmap_data_updated_at timestamptz;
