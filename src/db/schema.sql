-- Simulated wall clock: a single row holding the engine's current "now".
-- All scheduling and due-date comparisons run against this, not Date.now(),
-- so time can be fast-forwarded deterministically.
CREATE TABLE IF NOT EXISTS clock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  now_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  company TEXT NOT NULL,
  role TEXT NOT NULL,
  segment TEXT NOT NULL,
  timezone TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  -- next_action_ms is when the scheduler should next look at this contact
  -- (send the next step, or deactivate). NULL means no further action (terminal).
  next_action_ms INTEGER,
  next_action_type TEXT,
  reply_classification TEXT
);

CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
CREATE INDEX IF NOT EXISTS idx_contacts_next_action ON contacts(next_action_ms);

-- Full audit history: every send, bounce, reply, unsubscribe and deactivation.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  type TEXT NOT NULL, -- sent | bounced | replied | unsubscribed | deactivated
  step TEXT,          -- first | follow_up_1 | follow_up_2 | follow_up_3 (for sent/bounced)
  classification TEXT,-- interested | not_interested | out_of_office (for replied)
  subject TEXT,
  body TEXT,
  occurred_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_contact ON events(contact_id);
CREATE INDEX IF NOT EXISTS idx_events_occurred ON events(occurred_at_ms);

-- Pending inbound events (a reply or unsubscribe that will "arrive" at a
-- future simulated time, generated at send-time so outcomes are decided once
-- and re-running the workflow can never duplicate or re-roll them).
CREATE TABLE IF NOT EXISTS inbound_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  kind TEXT NOT NULL, -- reply | unsubscribe
  raw_text TEXT,       -- the mock inbound email body (classified via AI/fallback when applied)
  scheduled_at_ms INTEGER NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_inbound_due ON inbound_events(applied, scheduled_at_ms);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_contact_unique ON inbound_events(contact_id)
  WHERE applied = 0;

-- Cached AI-written template per (segment, step). Generated once per
-- segment/step combination (not per contact) to keep AI calls O(segments)
-- rather than O(contacts), which is what makes 10,000 contacts tractable
-- against OpenRouter's free-tier rate limits.
CREATE TABLE IF NOT EXISTS ai_templates (
  segment TEXT NOT NULL,
  step TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  source TEXT NOT NULL, -- 'ai' | 'fallback'
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (segment, step)
);

-- Mock mailbox config, used by the mock email provider to simulate
-- per-recipient-domain / global send outcomes consistently.
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
