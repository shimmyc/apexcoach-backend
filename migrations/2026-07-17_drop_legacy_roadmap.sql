-- Drops the legacy free-text macro roadmap columns (ROADMAP.md §9).
--
-- Confirmed no external consumer reads them: GET /api/profiles/:id/life-os-summary
-- and PROFILE_SELECT_BASE (used by GET/PATCH /api/profiles/:id and PIN verify)
-- both use explicit column lists that never included `roadmap`/`roadmap_updated_at`.
-- Superseded by the structured profiles.roadmap_data (added 2026-05-22, UI shipped
-- 2026-05-29). GET/POST /api/profiles/:id/roadmap and the client fns
-- loadRoadmap()/renderRoadmapContent()/generateRoadmap() (+ the hidden
-- #roadmap-card) were removed from the app on 2026-07-17.
--
-- Run any time after the server-side endpoint removal has deployed.

ALTER TABLE profiles DROP COLUMN IF EXISTS roadmap;
ALTER TABLE profiles DROP COLUMN IF EXISTS roadmap_updated_at;
