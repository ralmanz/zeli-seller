-- zeli-seller D1 schema
-- Apply: wrangler d1 execute zeli-seller --file=schema.sql

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS brokers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  agency     TEXT,
  wa_number  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS listings (
  id            TEXT PRIMARY KEY,
  slug          TEXT UNIQUE,
  broker_id     TEXT NOT NULL REFERENCES brokers(id),
  operation     TEXT CHECK (operation IN ('sale', 'rent')),
  price         REAL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  location      TEXT,
  beds          INTEGER,
  baths         REAL,
  area_m2       REAL,
  parking       INTEGER,
  facts_json    TEXT,
  cover_r2_key  TEXT,
  status        TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'active', 'archived')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT
);

CREATE TABLE IF NOT EXISTS knowledge (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT NOT NULL CHECK (scope IN ('listing', 'durable')),
  listing_id TEXT REFERENCES listings(id),
  broker_id  TEXT NOT NULL REFERENCES brokers(id),
  topic      TEXT NOT NULL,
  answer     TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'high'
               CHECK (confidence IN ('high', 'low')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text            TEXT NOT NULL,
  gate_decision   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS escalations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT,
  listing_id      TEXT NOT NULL REFERENCES listings(id),
  question        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'resolved')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id      TEXT NOT NULL REFERENCES listings(id),
  conversation_id TEXT,
  intent          TEXT NOT NULL
                    CHECK (intent IN ('viewing', 'offer', 'financing', 'none')),
  status          TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'contacted', 'closed')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_listings_broker_status
  ON listings (broker_id, status);

CREATE INDEX IF NOT EXISTS idx_knowledge_listing
  ON knowledge (scope, listing_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_knowledge_broker
  ON knowledge (scope, broker_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages (conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_escalations_listing_status
  ON escalations (listing_id, status);

CREATE INDEX IF NOT EXISTS idx_leads_listing
  ON leads (listing_id, status);
