/**
 * Applies supabase/migrations/20260505120000_three_roll_watch_nudge.sql
 * to the hosted Postgres (adds three_roll_watch_nudge_shown_at).
 *
 * Usage (from repo root or backend/):
 *   DATABASE_URL='postgresql://postgres.[ref]:[PASSWORD]@...' npm run migrate:three-roll --prefix backend
 *
 * Copy URI from Supabase → Project Settings → Database → Connection string → URI.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const sqlPath = path.join(repoRoot, "supabase/migrations/20260505120000_three_roll_watch_nudge.sql");

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("Missing DATABASE_URL. Use your Supabase Postgres URI (includes password).");
  process.exit(1);
}

if (!fs.existsSync(sqlPath)) {
  console.error("Migration file not found:", sqlPath);
  process.exit(1);
}

const sql = fs.readFileSync(sqlPath, "utf8");
const { Client } = pg;
const client = new Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false }
});

await client.connect();
try {
  await client.query(sql);
  console.log("OK — column three_roll_watch_nudge_shown_at is present on anonymous_session_funnel.");
} finally {
  await client.end();
}
