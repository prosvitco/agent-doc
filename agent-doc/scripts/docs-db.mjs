// scripts/docs-db.mjs
//
// Builds a SQLite index from the JSON model, and runs queries against it.
//
// THE DB IS DERIVED, NEVER THE SOURCE. It is rebuilt from `docs/data/**` on
// every run and is gitignored. That split is the whole point:
//
//   JSON in git   diffable, blameable, mergeable, reviewable — and the reasoning
//                 in `reports/` stays prose rather than an escaped string
//   SQLite here   joins, aggregates and ad-hoc questions the CLI flags will
//                 never anticipate
//
// A binary file as the source of truth would have cost `git diff`, `git blame`
// and reviewable change on the project's most valuable artefact — the record of
// why something was rejected and when. Derived, it costs nothing: if it is ever
// wrong, delete it and rebuild.
//
//   npm run docs:db                       rebuild
//   npm run docs:query "SELECT …"         run SQL
//   npm run docs:query -- --open          open questions, a canned query
//
// Uses node:sqlite — built in, no dependency.

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { areas, carriesEntries, docTypes, linkRels, noteTypes, priorities } from "../docs/taxonomy.mjs";
import { DOCS, load, summaryOf } from "./docs-lib.mjs";

export const DB_PATH = join(DOCS, "data", ".docs.db");

const SCHEMA = `
CREATE TABLE doc_type    (name TEXT PRIMARY KEY);
CREATE TABLE area        (name TEXT PRIMARY KEY, describes TEXT);
CREATE TABLE status      (type TEXT, name TEXT, describes TEXT, PRIMARY KEY (type, name));
CREATE TABLE rel         (name TEXT PRIMARY KEY, describes TEXT);
CREATE TABLE note_type   (name TEXT PRIMARY KEY, describes TEXT);
CREATE TABLE priority    (name TEXT PRIMARY KEY, rank INTEGER NOT NULL, describes TEXT);

CREATE TABLE resource (
  id       TEXT PRIMARY KEY,
  type     TEXT NOT NULL REFERENCES doc_type(name),
  title    TEXT NOT NULL,
  status   TEXT NOT NULL,
  priority TEXT REFERENCES priority(name),
  summary  TEXT,
  at       TEXT,
  note_kind TEXT REFERENCES note_type(name),
  parent_id TEXT REFERENCES resource(id),
  source_system TEXT,
  source_url    TEXT,
  FOREIGN KEY (type, status) REFERENCES status(type, name)
);

-- a doc may carry several values on an axis
CREATE TABLE tag (
  doc   TEXT NOT NULL REFERENCES resource(id),
  axis  TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (doc, axis, value)
);

-- the pivot, mirrored exactly from links.jsonl
CREATE TABLE link (
  "from" TEXT NOT NULL REFERENCES resource(id),
  rel    TEXT NOT NULL REFERENCES rel(name),
  "to"   TEXT NOT NULL REFERENCES resource(id),
  PRIMARY KEY ("from", rel, "to")
);

CREATE TABLE report_entry (
  report_id TEXT NOT NULL REFERENCES resource(id),
  idx       INTEGER NOT NULL,
  type      TEXT NOT NULL,
  note      TEXT,
  file      TEXT,
  name      TEXT,
  value     REAL,
  PRIMARY KEY (report_id, idx)
);

CREATE INDEX link_to ON link("to", rel);
CREATE INDEX res_parent ON resource(parent_id);
`;

export function build() {
  const { byId, links, tags, problems } = load();
  if (problems.length) {
    console.error(`docs:db — model has ${problems.length} problem(s); run \`npm run docs:check\``);
    for (const p of problems.slice(0, 5)) console.error(`  ${p}`);
    process.exit(1);
  }

  if (existsSync(DB_PATH)) rmSync(DB_PATH);
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);

  // enums become real tables, so the DB enforces the same vocabulary the
  // validator does rather than trusting the loader
  for (const [type, spec] of Object.entries(docTypes)) {
    db.prepare("INSERT INTO doc_type VALUES (?)").run(type);
    for (const [name, describes] of Object.entries(spec.status)) {
      db.prepare("INSERT INTO status VALUES (?,?,?)").run(type, name, describes);
    }
  }
  for (const [n, d] of Object.entries(areas)) db.prepare("INSERT INTO area VALUES (?,?)").run(n, d);
  for (const [n, p] of Object.entries(priorities)) {
    db.prepare("INSERT INTO priority VALUES (?,?,?)").run(n, p.rank, p.describes);
  }
  for (const [n, d] of Object.entries(linkRels)) db.prepare("INSERT INTO rel VALUES (?,?)").run(n, d);
  for (const [n, d] of Object.entries(noteTypes)) db.prepare("INSERT INTO note_type VALUES (?,?)").run(n, d);

  const ins = db.prepare(
    `INSERT INTO resource (id,type,title,status,priority,summary,at,note_kind,parent_id,source_system,source_url)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  // Filename (id) order is not parent-before-child order — ids are random
  // suffixes, so a parent can sort after its own child. A resource's parent_id
  // FK requires the parent row to already exist, so insert in hierarchy order.
  for (const r of parentsFirst(byId)) {
    // summary is DERIVED from the prose, like the database itself — so
    // `WHERE summary LIKE …` searches what the document says, not its title
    ins.run(r.id, r.type, r.title, r.status, r.priority ?? null, summaryOf(r, byId, links) ?? null,
      r.at ?? null, r.kind ?? null, r.parent_id ?? null,
      r.source?.system ?? null, r.source?.url ?? null);
  }
  const insTag = db.prepare("INSERT INTO tag VALUES (?,?,?)");
  for (const t of tags) insTag.run(t.doc, t.axis, t.value);

  const insLink = db.prepare(`INSERT INTO link ("from",rel,"to") VALUES (?,?,?)`);
  for (const l of links) insLink.run(l.from, l.rel, l.to);

  const insEntry = db.prepare(
    "INSERT INTO report_entry (report_id,idx,type,note,file,name,value) VALUES (?,?,?,?,?,?,?)",
  );
  for (const r of byId.values()) {
    if (!carriesEntries(r.type)) continue;
    (r.entries ?? []).forEach((e, i) =>
      insEntry.run(r.id, i, e.type, e.note ?? null, e.file ?? null, e.name ?? null,
        typeof e.value === "number" ? e.value : null));
  }

  db.close();
  return { resources: byId.size, links: links.length, tags: tags.length };
}

/** Resources in an order where every parent_id precedes the row that names it. */
function parentsFirst(byId) {
  const ordered = [];
  const visited = new Set();
  const visit = (id) => {
    if (visited.has(id)) return;
    visited.add(id);
    const r = byId.get(id);
    if (r.parent_id && byId.has(r.parent_id)) visit(r.parent_id);
    ordered.push(r);
  };
  for (const id of byId.keys()) visit(id);
  return ordered;
}
