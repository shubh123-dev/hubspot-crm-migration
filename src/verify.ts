import { ENGAGEMENT_TYPES } from "./config";
import { pool } from "./db";
import * as hs from "./hubspot";

// Post-import checks. Exits non-zero if any count mismatches or a sampled
// record differs from live HubSpot.
//
//   npm run verify                  # counts + orphans + 25-company spot check
//   npm run verify -- --sample 100

// Properties compared field-by-field in the spot check: what ai-sales-poc relies on.
const SPOT_CHECK_PROPS = [
  "name", "domain", "hubspot_owner_id", "lifecyclestage",
  "ai_sequence_step", "ai_last_email_sent", "ai_last_message_id", "ai_last_contact_id",
  "ai_email_status", "ai_requeue_date", "ai_targeting_bracket", "outreach_status",
];

let failures = 0;
function check(ok: boolean, line: string) {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${line}`);
  if (!ok) failures++;
}

async function scalar(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query(sql, params);
  return Number(Object.values(rows[0])[0]);
}

async function counts() {
  console.log("\nRecord counts (HubSpot vs Postgres, non-archived):");
  const targets: [string, string, unknown[]][] = [
    ["companies", "SELECT count(*) FROM companies WHERE NOT archived", []],
    ["contacts", "SELECT count(*) FROM contacts WHERE NOT archived", []],
    ...Object.entries(ENGAGEMENT_TYPES).map(([objectType, type]): [string, string, unknown[]] => [
      objectType, "SELECT count(*) FROM engagements WHERE type = $1 AND NOT archived", [type],
    ]),
  ];
  for (const [objectType, sql, params] of targets) {
    const db = await scalar(sql, params);
    try {
      const remote = await hs.countObjects(objectType);
      // Records created in HubSpot after the import started legitimately make remote > db.
      check(db === remote, `${objectType.padEnd(10)} hubspot=${remote} postgres=${db}${db !== remote ? ` (diff ${remote - db})` : ""}`);
    } catch (err) {
      if (err instanceof hs.HubSpotError && err.status === 403) {
        console.log(`  SKIP ${objectType.padEnd(10)} token lacks scope; postgres=${db}`);
      } else throw err;
    }
  }
}

async function orphans() {
  console.log("\nReferential checks (expected to be small, not necessarily zero):");
  const q: [string, string][] = [
    ["companies with unknown owner_id", "SELECT count(*) FROM companies c WHERE owner_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM owners o WHERE o.id = c.owner_id)"],
    ["company_contacts -> missing contact", "SELECT count(*) FROM company_contacts cc WHERE NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = cc.contact_id)"],
    ["engagement links -> missing company", "SELECT count(*) FROM engagement_associations ea WHERE object_type = 'company' AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = ea.object_id)"],
    ["engagement links -> missing contact", "SELECT count(*) FROM engagement_associations ea WHERE object_type = 'contact' AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = ea.object_id)"],
    ["companies with ai_sequence_step > 0", "SELECT count(*) FROM companies WHERE ai_sequence_step > 0"],
  ];
  for (const [label, sql] of q) console.log(`  ${String(await scalar(sql)).padStart(8)}  ${label}`);

  // Rows not refreshed by the latest full import were probably deleted in HubSpot.
  const stale = await pool.query(`
    WITH last AS (
      SELECT started_at FROM import_runs
      WHERE status LIKE 'succeeded%' AND 'companies' = ANY(steps) AND 'contacts' = ANY(steps)
        AND NOT stats ? 'limit'
      ORDER BY started_at DESC LIMIT 1)
    SELECT (SELECT count(*) FROM companies, last WHERE imported_at < last.started_at) AS companies,
           (SELECT count(*) FROM contacts,  last WHERE imported_at < last.started_at) AS contacts`);
  console.log(`  ${String(stale.rows[0].companies).padStart(8)}  companies not seen in latest full import (deleted in HubSpot?)`);
  console.log(`  ${String(stale.rows[0].contacts).padStart(8)}  contacts not seen in latest full import (deleted in HubSpot?)`);
}

function normalize(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

async function spotCheck(sample: number) {
  console.log(`\nSpot check: ${sample} random companies vs live HubSpot:`);
  const { rows } = await pool.query<{ id: string; properties: Record<string, string | null> }>(
    "SELECT id, properties FROM companies WHERE NOT archived ORDER BY random() LIMIT $1", [sample],
  );
  if (rows.length === 0) return console.log("  (no companies imported)");
  const live = new Map<string, hs.HsObject>();
  for (let i = 0; i < rows.length; i += 100) {
    for (const o of await hs.readObjects("companies", rows.slice(i, i + 100).map((r) => r.id), SPOT_CHECK_PROPS)) {
      live.set(String(o.id), o);
    }
  }
  let mismatched = 0;
  for (const row of rows) {
    const remote = live.get(row.id);
    if (!remote) {
      console.log(`  company ${row.id}: no longer exists in HubSpot`);
      mismatched++;
      continue;
    }
    const diffs = SPOT_CHECK_PROPS.filter((p) => normalize(row.properties[p]) !== normalize(remote.properties[p]));
    if (diffs.length) {
      mismatched++;
      console.log(`  company ${row.id}: ${diffs.map((p) => `${p} db="${normalize(row.properties[p])}" hubspot="${normalize(remote.properties[p])}"`).join("; ")}`);
    }
  }
  // Note: the live pipeline keeps writing to HubSpot, so a few diffs right
  // after a send window are expected; re-import and re-verify to confirm.
  check(mismatched === 0, `${rows.length - mismatched}/${rows.length} sampled companies match HubSpot`);
}

async function main() {
  const i = process.argv.indexOf("--sample");
  const sample = i >= 0 ? Number(process.argv[i + 1]) : 25;
  await counts();
  await orphans();
  await spotCheck(sample);
  console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
  if (failures) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
