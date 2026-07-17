-- Wearable connection health flag.
-- Run once in the Supabase SQL editor.
--
-- Adds a persisted needs_reconnect flag to wearable_connections so the
-- providers endpoint can report real token health instead of mere row
-- existence. Set true when a token refresh returns invalid_grant /
-- RECONNECT_REQUIRED; cleared to false on any successful (re)connect or
-- token refresh. Defaults to false so every existing row is treated as
-- healthy until proven otherwise.
--
-- The server writes this flag best-effort (a failure here never blocks a
-- token save) and reads it defensively (the providers endpoint falls back
-- to false if this column is somehow absent), so applying this migration a
-- little before or after the code deploy cannot break token persistence or
-- the providers endpoint — but the flag only actually persists/reports once
-- this has run.

ALTER TABLE wearable_connections
  ADD COLUMN IF NOT EXISTS needs_reconnect boolean NOT NULL DEFAULT false;
