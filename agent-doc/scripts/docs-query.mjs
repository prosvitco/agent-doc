// scripts/docs-query.mjs — query the derived index. Rebuilds it first, always,
// so the answer cannot be stale: the DB is a cache of the JSON, never a source.
import { DatabaseSync } from "node:sqlite";
import { build, DB_PATH } from "./docs-db.mjs";

const CANNED = {
  "--open": `SELECT r.id, r.priority, group_concat(t.value) AS areas, r.title
             FROM resource r LEFT JOIN tag t ON t.doc=r.id AND t.axis='area'
             LEFT JOIN priority p ON p.name=r.priority
             WHERE r.type='task' AND r.status='open'
             GROUP BY r.id ORDER BY coalesce(p.rank,99), CAST(r.id AS INTEGER)`,
  "--blocked": `SELECT r.id, r.title, group_concat(l."to") AS waiting_on
                FROM resource r JOIN link l ON l."from"=r.id AND l.rel='blocked_on'
                GROUP BY r.id`,
  "--ledger": `SELECT n.at, n.title, group_concat(l."to") AS about
               FROM resource n LEFT JOIN link l ON l."from"=n.id AND l.rel='annotates'
               WHERE n.type='note' AND n.note_kind='rejection' GROUP BY n.id ORDER BY n.at`,
  "--tree": `SELECT c.id, c.type, c.title, c.parent_id FROM resource c
             WHERE c.parent_id IS NOT NULL ORDER BY c.parent_id, c.id`,
  "--orphans": `SELECT id, type, title FROM resource
                WHERE id NOT IN (SELECT "from" FROM link UNION SELECT "to" FROM link)`,
};

build();
const arg = process.argv[2];
const sql = CANNED[arg] ?? arg;
if (!sql) {
  console.log("usage: npm run docs:query \"<SQL>\"   |   " + Object.keys(CANNED).join(" | "));
  process.exit(0);
}
const db = new DatabaseSync(DB_PATH, { readOnly: true });
const rows = db.prepare(sql).all();
if (!rows.length) {
  console.log("(no rows)");
  process.exit(0);
}
const cols = Object.keys(rows[0]);
const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
console.log(cols.map((c, i) => c.padEnd(w[i])).join("  "));
console.log(w.map((n) => "-".repeat(n)).join("  "));
for (const r of rows) console.log(cols.map((c, i) => String(r[c] ?? "").padEnd(w[i])).join("  "));
