import fs from "fs";
import path from "path";
import { pool } from "./db";

// Applies db/schema.sql. Idempotent, safe to run before every import.
async function main() {
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8");
  await pool.query(sql);
  console.log("Schema applied.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
