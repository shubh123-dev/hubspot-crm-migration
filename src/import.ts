import { ENGAGEMENT_TYPES } from "./config";
import { pool, upsert, withTransaction } from "./db";
import * as hs from "./hubspot";
import * as t from "./transform";

// Full, idempotent HubSpot -> Postgres import. Re-running it refreshes every row.
//
//   npm run import                                 # everything
//   npm run import -- --only companies,contacts    # a subset of steps
//   npm run import -- --limit 200                  # trial run: first ~200 objects per type (whole pages of 100)
//
// Steps run in dependency order. Associations are refreshed per source object
// (old links deleted, current links inserted) so links removed in HubSpot go away.

const STEPS = ["properties", "owners", "companies", "contacts", "associations", "engagements"] as const;
type Step = (typeof STEPS)[number];

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const only = get("--only")?.split(",").map((s) => s.trim()) as Step[] | undefined;
  for (const s of only ?? []) {
    if (!STEPS.includes(s)) throw new Error(`Unknown step "${s}". Valid: ${STEPS.join(", ")}`);
  }
  const limit = get("--limit") ? Number(get("--limit")) : Infinity;
  return { steps: only ?? [...STEPS], limit };
}

const stats: Record<string, number | string> = {};
const warnings: string[] = [];
const bump = (key: string, n: number) => { stats[key] = ((stats[key] as number) || 0) + n; };

// Property names per object type, loaded once and reused for batch reads.
const propertyNames = new Map<string, string[]>();
async function propertiesFor(objectType: string): Promise<string[]> {
  if (!propertyNames.has(objectType)) {
    const defs = await hs.getPropertyDefinitions(objectType);
    propertyNames.set(objectType, defs.map((d) => d.name));
  }
  return propertyNames.get(objectType)!;
}

/** A missing OAuth scope on one object type shouldn't kill the whole run. */
async function scoped(label: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof hs.HubSpotError && err.status === 403) {
      const msg = `${label}: skipped, token is missing the required scope (${err.message})`;
      console.warn(`  WARNING ${msg}`);
      warnings.push(msg);
      return;
    }
    throw err;
  }
}

async function importProperties() {
  for (const objectType of ["companies", "contacts", ...Object.keys(ENGAGEMENT_TYPES)]) {
    await scoped(`properties/${objectType}`, async () => {
      const defs = await hs.getPropertyDefinitions(objectType);
      propertyNames.set(objectType, defs.map((d) => d.name));
      await withTransaction((c) =>
        upsert(c, "property_definitions", defs.map((d) => t.propertyDefinitionRow(objectType, d)), ["object_type", "name"]),
      );
      bump(`properties.${objectType}`, defs.length);
      console.log(`  ${objectType}: ${defs.length} property definitions`);
    });
  }
}

async function importOwners() {
  // Archived (deactivated) owners are imported too: old companies/engagements still point at them.
  for (const archived of [false, true]) {
    for await (const page of hs.listOwners(archived)) {
      await withTransaction((c) => upsert(c, "owners", page.map(t.ownerRow), ["id"]));
      bump("owners", page.length);
    }
  }
  console.log(`  ${stats.owners ?? 0} owners`);
}

async function importObjects(objectType: string, table: string, toRow: (o: hs.HsObject) => Record<string, unknown>, limit: number) {
  const props = await propertiesFor(objectType);
  let n = 0;
  for await (const page of hs.listObjects(objectType, props)) {
    await withTransaction((c) => upsert(c, table, page.map(toRow), ["id"]));
    n += page.length;
    if (n % 1000 < page.length) console.log(`  ${objectType}: ${n}...`);
    if (n >= limit) break;
  }
  return n;
}

async function importCompanies(limit: number) {
  const n = await importObjects("companies", "companies", t.companyRow, limit);
  bump("companies", n);
  console.log(`  ${n} companies`);
}

async function importContacts(limit: number) {
  const n = await importObjects("contacts", "contacts", t.contactRow, limit);
  bump("contacts", n);
  console.log(`  ${n} contacts`);
}

async function importCompanyContacts() {
  // Driven by the companies already in Postgres, so run after `companies`.
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM companies WHERE NOT archived ORDER BY id");
  for (let i = 0; i < rows.length; i += 1000) {
    const ids = rows.slice(i, i + 1000).map((r) => r.id);
    const links = await hs.getAssociations("companies", "contacts", ids);
    const assocRows = [...links].flatMap(([companyId, tos]) =>
      tos.map((to) => ({
        company_id: companyId,
        contact_id: to.toId,
        is_primary: t.isPrimary(to.types),
        association_types: JSON.stringify(to.types),
      })),
    );
    await withTransaction(async (c) => {
      await c.query("DELETE FROM company_contacts WHERE company_id = ANY($1)", [ids]);
      // Chunked to stay under Postgres' 65535 bind-parameter limit.
      for (let j = 0; j < assocRows.length; j += 5000) {
        await upsert(c, "company_contacts", assocRows.slice(j, j + 5000), ["company_id", "contact_id"]);
      }
    });
    bump("company_contacts", assocRows.length);
    console.log(`  companies ${Math.min(i + 1000, rows.length)}/${rows.length}: ${stats.company_contacts} links`);
  }
}

async function importEngagements(limit: number) {
  for (const [objectType, type] of Object.entries(ENGAGEMENT_TYPES)) {
    await scoped(`engagements/${objectType}`, async () => {
      const props = await propertiesFor(objectType);
      let n = 0;
      for await (const page of hs.listObjects(objectType, props)) {
        const ids = page.map((o) => String(o.id));
        const toCompanies = await hs.getAssociations(objectType, "companies", ids);
        const toContacts = await hs.getAssociations(objectType, "contacts", ids);
        const assocRows = [
          ...[...toCompanies].flatMap(([id, tos]) => tos.map((to) => ({ ...to, id, object_type: "company" }))),
          ...[...toContacts].flatMap(([id, tos]) => tos.map((to) => ({ ...to, id, object_type: "contact" }))),
        ].map((a) => ({
          engagement_type: type,
          engagement_id: a.id,
          object_type: a.object_type,
          object_id: a.toId,
          association_types: JSON.stringify(a.types),
        }));

        await withTransaction(async (c) => {
          await upsert(c, "engagements", page.map((o) => t.engagementRow(type, o)), ["type", "id"]);
          await c.query("DELETE FROM engagement_associations WHERE engagement_type = $1 AND engagement_id = ANY($2)", [type, ids]);
          for (let j = 0; j < assocRows.length; j += 5000) {
            await upsert(c, "engagement_associations", assocRows.slice(j, j + 5000), [
              "engagement_type", "engagement_id", "object_type", "object_id",
            ]);
          }
        });
        n += page.length;
        bump("engagement_associations", assocRows.length);
        if (n % 1000 < page.length) console.log(`  ${objectType}: ${n}...`);
        if (n >= limit) break;
      }
      bump(`engagements.${type}`, n);
      console.log(`  ${n} ${objectType}`);
    });
  }
}

async function main() {
  const { steps, limit } = parseArgs();
  const run = await pool.query<{ id: string }>("INSERT INTO import_runs (steps) VALUES ($1) RETURNING id", [steps]);
  const runId = run.rows[0].id;
  if (Number.isFinite(limit)) stats.limit = limit; // partial run: excluded from verify's stale-row check
  console.log(`Import run #${runId}: ${steps.join(", ")}${Number.isFinite(limit) ? ` (limit ${limit})` : ""}`);

  try {
    for (const step of steps) {
      console.log(`\n[${step}]`);
      if (step === "properties") await importProperties();
      if (step === "owners") await importOwners();
      if (step === "companies") await importCompanies(limit);
      if (step === "contacts") await importContacts(limit);
      if (step === "associations") await importCompanyContacts();
      if (step === "engagements") await importEngagements(limit);
    }
    if (warnings.length) stats.warnings = warnings.join("\n");
    const status = warnings.length ? "succeeded_with_warnings" : "succeeded";
    await pool.query("UPDATE import_runs SET finished_at = now(), status = $2, stats = $3 WHERE id = $1", [runId, status, stats]);
    console.log(`\nImport run #${runId} ${status}:`, stats);
  } catch (err) {
    await pool.query("UPDATE import_runs SET finished_at = now(), status = 'failed', stats = $2, error = $3 WHERE id = $1", [
      runId, stats, String((err as Error).stack || err),
    ]);
    throw err;
  }
}

main()
  .catch((err) => {
    console.error("\nImport failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
