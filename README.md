# hubspot-crm-migration

Moves AdMedia's HubSpot CRM data into an internal Postgres CRM.

This project is **read-only against HubSpot**: it never writes to HubSpot.
The existing `ai-sales-poc` sales pipeline keeps running on HubSpot unchanged
while this import is built up and verified.

## What gets migrated

| HubSpot                                        | Postgres table              |
| ---------------------------------------------- | --------------------------- |
| Property definitions (incl. custom `ai_*`)     | `property_definitions`      |
| Owners (active + deactivated)                  | `owners`                    |
| Companies (all properties)                     | `companies`                 |
| Contacts (all properties)                      | `contacts`                  |
| Company ↔ contact associations (+ labels)      | `company_contacts`          |
| Emails, notes, calls, meetings, tasks          | `engagements`               |
| Engagement ↔ company / contact associations    | `engagement_associations`   |
| Each import run, its stats and errors          | `import_runs`               |

Every row keeps HubSpot's ID as its primary key and the **full HubSpot property
bag** in a `properties` JSONB column, so no data is lost even for properties
that aren't modelled as columns. The fields the sales pipeline relies on
(`ai_sequence_step`, `ai_last_email_sent`, `ai_requeue_date`, `outreach_status`,
`contact_email_status`, and the rest) are also promoted to typed columns. A value
that can't be parsed (for example a malformed date) becomes `NULL` in the typed
column, and the original string stays in `properties`. See `db/schema.sql`.

Archived/deleted HubSpot records are not imported, except deactivated owners,
which old records still reference.

## Setup

```bash
npm install
cp .env.example .env
#  - HUBSPOT_TOKEN: copy the value from ai-sales-poc's .env
#  - DATABASE_URL:  your Postgres (or `docker compose up -d` for a local one)
npm run migrate          # create tables (idempotent)
```

The token needs read scopes for companies, contacts, owners, the companies/contacts
schemas, and `sales-email-read` for email bodies. If a scope is missing, that object
type is skipped. The run then finishes as `succeeded_with_warnings` and lists what
was skipped.

## Running

```bash
npm run import -- --limit 200                # trial run: first ~200 per object type (rounded up to a page of 100)
npm run import                               # full import
npm run import -- --only engagements         # one or more steps:
                                             # properties,owners,companies,contacts,associations,engagements
npm run verify                               # check the import (see below)
npm run verify -- --sample 200
npm run typecheck
```

The import is **idempotent**: it upserts every row, so you can re-run it at any
time to refresh the data. Each page commits on its own, so an interrupted run
keeps everything it had already written; re-run it to finish. Associations are
replaced per source record, so links removed in HubSpot are removed here too.
HubSpot calls are throttled (~9 req/s by default) and retried with backoff on
429 / 5xx / network errors.

`npm run verify` checks:

- record counts, HubSpot vs Postgres, for each object type
- references that point nowhere (e.g. a company whose owner isn't in `owners`)
- rows the latest full import didn't see, which were probably deleted in HubSpot
  (they're reported, never deleted)
- a field-by-field comparison of a random sample of companies against live
  HubSpot, on the fields the sales pipeline uses

The live pipeline keeps writing to HubSpot, so you can expect small differences
right after a send window. Re-import, then re-verify.

## Cutover plan

1. **Backfill (this repo).** Run the full import and verify it. Re-run nightly
   (cron) to keep Postgres close to HubSpot.
2. **Dual-write (ai-sales-poc).** Put a CRM interface in front of
   `src/hubspot.ts` and have every write (sequence step, `logToHubSpot`,
   requeue, replies, verification status) go to both HubSpot and Postgres.
   Reads still come from HubSpot. Compare the two with `npm run verify`.
3. **Switch reads.** Point the scheduler's reads (`fetchActiveBracketCompanies`,
   `getContacts`, owners) at Postgres. HubSpot remains a fallback.
4. **Retire HubSpot.** Stop the HubSpot writes, take a final import as an
   archive, and revoke the token.

## Not migrated yet

- Deals, tickets, lists, workflows, sequences, and files/attachments.
- Property **history** (only current values are imported).
- Incremental sync: every run is a full re-import. That's fine at current volume.
  If it gets slow, add a `hs_lastmodifieddate` filter.
