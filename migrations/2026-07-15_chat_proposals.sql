-- Coach Chat tool-use: persists pending write proposals (goal updates, focus
-- override changes, check-in notes) so a page refresh doesn't orphan an
-- unconfirmed change. Run manually in the Supabase SQL editor. Matches the
-- RLS convention used by the other tables (service_role_bypass policy).

CREATE TABLE IF NOT EXISTS chat_proposals (
  id bigint generated always as identity primary key,
  thread_id bigint NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  message_id bigint REFERENCES chat_messages(id) ON DELETE CASCADE,
  tool_use_id text NOT NULL,
  type text NOT NULL CHECK (type IN ('update_goal', 'set_focus_override', 'log_checkin_note')),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'canceled')),
  created_at timestamptz DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_chat_proposals_thread_status ON chat_proposals(thread_id, status);

ALTER TABLE chat_proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_bypass ON chat_proposals
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- No migration needed for the new goal.target_date field -- profile_data.goals[]
-- is a jsonb array with no rigid per-key schema, so a new optional key is
-- purely additive and requires no ALTER TABLE.
