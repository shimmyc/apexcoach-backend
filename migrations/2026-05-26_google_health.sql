-- Google Health API v4 support (2026-05-26)
--
-- Adds a jsonb metadata bag to wearable_connections so the Google Health
-- OAuth callback can persist the user's stable Google Health identity
-- ({ healthUserId, legacyUserId }) alongside the existing token columns.
-- Provider-agnostic: any future adapter can stash provider-specific metadata
-- here without further schema changes.
--
-- Run once in the Supabase SQL editor.

ALTER TABLE wearable_connections
  ADD COLUMN IF NOT EXISTS provider_metadata jsonb DEFAULT '{}'::jsonb;
