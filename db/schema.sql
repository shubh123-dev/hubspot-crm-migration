-- Internal CRM schema (Postgres 13+).
--
-- Design rules:
--   * HubSpot object IDs are kept as the primary key (TEXT) so every row can be
--     traced back to its HubSpot record and the import is idempotent (upserts).
--   * Every object keeps its FULL HubSpot property bag in `properties` (JSONB).
--     Nothing is dropped, even properties we don't model as columns yet.
--   * The columns the ai-sales-poc pipeline actually reads are promoted to typed
--     columns (sequence state, verification status, etc.).
--   * No foreign keys between imported tables: HubSpot regularly references
--     archived/deleted owners and objects, and the raw import must not reject
--     those rows. Run `npm run verify` to see orphan counts.
--
-- Safe to re-run: every statement is idempotent.

CREATE TABLE IF NOT EXISTS import_runs (
  id           BIGSERIAL PRIMARY KEY,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'running',  -- running | succeeded | failed
  steps        TEXT[] NOT NULL,
  stats        JSONB NOT NULL DEFAULT '{}'::jsonb,
  error        TEXT
);

-- HubSpot property definitions, so custom property labels/options survive.
CREATE TABLE IF NOT EXISTS property_definitions (
  object_type  TEXT NOT NULL,           -- companies | contacts | emails | notes | ...
  name         TEXT NOT NULL,
  label        TEXT,
  type         TEXT,                    -- string | number | date | datetime | enumeration | bool
  field_type   TEXT,
  group_name   TEXT,
  options      JSONB,
  is_custom    BOOLEAN,                 -- !hubspotDefined
  raw          JSONB NOT NULL,
  imported_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (object_type, name)
);

CREATE TABLE IF NOT EXISTS owners (
  id           TEXT PRIMARY KEY,
  user_id      TEXT,
  email        TEXT,
  first_name   TEXT,
  last_name    TEXT,
  teams        JSONB,
  archived     BOOLEAN NOT NULL DEFAULT false,
  hs_created_at TIMESTAMPTZ,
  hs_updated_at TIMESTAMPTZ,
  raw          JSONB NOT NULL,
  imported_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS owners_email_idx ON owners (lower(email));

CREATE TABLE IF NOT EXISTS companies (
  id                     TEXT PRIMARY KEY,
  name                   TEXT,
  domain                 TEXT,
  industry               TEXT,
  lifecycle_stage        TEXT,
  owner_id               TEXT,
  notes_last_contacted   TIMESTAMPTZ,
  notes_last_updated     TIMESTAMPTZ,
  last_sales_activity_at TIMESTAMPTZ,

  -- ai-sales-poc sequence state (custom HubSpot properties)
  ai_sequence_step       INTEGER,
  ai_last_email_sent     TIMESTAMPTZ,
  ai_last_message_id     TEXT,
  ai_message_id_history  TEXT,
  ai_last_contact_id     TEXT,
  ai_email_status        TEXT,
  ai_requeue_date        TIMESTAMPTZ,
  ai_targeting_bracket   TEXT,
  ai_active_contact_tier TEXT,
  ai_verification_status TEXT,
  outreach_status        TEXT,
  outreach_status_reason TEXT,

  properties             JSONB NOT NULL,
  archived               BOOLEAN NOT NULL DEFAULT false,
  hs_created_at          TIMESTAMPTZ,
  hs_updated_at          TIMESTAMPTZ,
  imported_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS companies_owner_idx    ON companies (owner_id);
CREATE INDEX IF NOT EXISTS companies_domain_idx   ON companies (lower(domain));
CREATE INDEX IF NOT EXISTS companies_lifecycle_idx ON companies (lifecycle_stage);
CREATE INDEX IF NOT EXISTS companies_sequence_idx ON companies (ai_sequence_step, ai_last_email_sent);
CREATE INDEX IF NOT EXISTS companies_props_gin    ON companies USING gin (properties jsonb_path_ops);

CREATE TABLE IF NOT EXISTS contacts (
  id                           TEXT PRIMARY KEY,
  email                        TEXT,
  first_name                   TEXT,
  last_name                    TEXT,
  job_title                    TEXT,
  owner_id                     TEXT,
  lifecycle_stage              TEXT,
  lead_status                  TEXT,
  email_opted_out              BOOLEAN,
  email_bad_address            BOOLEAN,

  -- ai-sales-poc verification state (custom HubSpot properties)
  ai_contact_sequence_priority TEXT,
  contact_email_status         TEXT,
  contact_email_status_reason  TEXT,
  contact_email_status_date    TIMESTAMPTZ,
  neverbounce_email_status     TEXT,

  properties                   JSONB NOT NULL,
  archived                     BOOLEAN NOT NULL DEFAULT false,
  hs_created_at                TIMESTAMPTZ,
  hs_updated_at                TIMESTAMPTZ,
  imported_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contacts_email_idx ON contacts (lower(email));
CREATE INDEX IF NOT EXISTS contacts_owner_idx ON contacts (owner_id);
CREATE INDEX IF NOT EXISTS contacts_props_gin ON contacts USING gin (properties jsonb_path_ops);

-- Company <-> contact links. One row per pair; all HubSpot association
-- types/labels for the pair are kept in `association_types`.
CREATE TABLE IF NOT EXISTS company_contacts (
  company_id         TEXT NOT NULL,
  contact_id         TEXT NOT NULL,
  is_primary         BOOLEAN NOT NULL DEFAULT false,
  association_types  JSONB NOT NULL DEFAULT '[]'::jsonb,
  imported_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, contact_id)
);
CREATE INDEX IF NOT EXISTS company_contacts_contact_idx ON company_contacts (contact_id);

-- Emails, notes, calls, meetings, tasks.
CREATE TABLE IF NOT EXISTS engagements (
  id           TEXT NOT NULL,
  type         TEXT NOT NULL,          -- email | note | call | meeting | task
  occurred_at  TIMESTAMPTZ,            -- hs_timestamp
  owner_id     TEXT,
  subject      TEXT,
  body         TEXT,
  direction    TEXT,                   -- hs_email_direction (emails only)
  status       TEXT,                   -- hs_email_status / hs_call_status / hs_task_status ...
  properties   JSONB NOT NULL,
  archived     BOOLEAN NOT NULL DEFAULT false,
  hs_created_at TIMESTAMPTZ,
  hs_updated_at TIMESTAMPTZ,
  imported_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (type, id)
);
CREATE INDEX IF NOT EXISTS engagements_occurred_idx ON engagements (occurred_at);
CREATE INDEX IF NOT EXISTS engagements_owner_idx    ON engagements (owner_id);

CREATE TABLE IF NOT EXISTS engagement_associations (
  engagement_type    TEXT NOT NULL,
  engagement_id      TEXT NOT NULL,
  object_type        TEXT NOT NULL,    -- company | contact
  object_id          TEXT NOT NULL,
  association_types  JSONB NOT NULL DEFAULT '[]'::jsonb,
  imported_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (engagement_type, engagement_id, object_type, object_id)
);
CREATE INDEX IF NOT EXISTS engagement_assoc_object_idx ON engagement_associations (object_type, object_id);
