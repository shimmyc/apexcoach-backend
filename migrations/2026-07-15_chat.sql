-- Coach Chat: one persistent thread per profile + its messages.
-- Run manually in the Supabase SQL editor. Matches the RLS convention used
-- by the other 11 tables (service_role_bypass policy; see CLAUDE.md → Row
-- Level Security).

CREATE TABLE IF NOT EXISTS chat_threads (
  id bigint generated always as identity primary key,
  profile_id bigint NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  summary text,
  summary_through_message_id bigint,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(profile_id)
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id bigint generated always as identity primary key,
  thread_id bigint NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  content text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_created ON chat_messages(thread_id, created_at);

ALTER TABLE chat_threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_bypass ON chat_threads
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_bypass ON chat_messages
  FOR ALL TO service_role USING (true) WITH CHECK (true);
