// scripts/docs-rm.mjs
//
// Removes documents, and everything that only existed to support them.
//
//   npm run docs:rm -- 9 11 12          delete, with a plan printed first
//   npm run docs:rm -- 9 --dry-run      show the plan, change nothing
//   npm run docs:rm -- 9 --force        delete even if something still links to it
//
// WHY THIS IS A COMMAND
//
// A document is four things in three places: a JSON file, tag rows, link rows in
// both directions, and a directory of prose. Deleting the JSON by hand leaves the
// other three, and the model's own integrity checks then fail on files nobody
// touched. The whole argument for a schema is that this class of mistake stops
// being possible.
//
// CASCADE IS NOT A FLAG
//
// A report must `documents` something — a report that stands alone is a guide, and
// `docs:check` enforces it. So deleting a document necessarily deletes any report
// whose ONLY subject was that document: leaving it behind would produce a model
// that cannot validate. That is not a policy choice to opt into, it is what the
// schema already says, so it happens automatically and is printed.
//
// Everything else that points at the target BLOCKS, and names itself. A dangling
// reference is a decision for a person, not a default.

import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DOCS, load } from "./docs-lib.mjs";

const DATA = join(DOCS, "data");

const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");
const ids = process.argv.slice(2).filter((a) => /^\d+$/.test(a));

if (!ids.length) {
  console.error(`usage: npm run docs:rm -- <id> [<id>…] [--dry-run] [--force]

Deletes documents, their tags, their links in both directions, and their prose.
Reports left with nothing to document are removed too, because the schema does
not permit them to exist. Anything else still pointing at a target blocks.`);
  process.exit(1);
}

const { byId, links, problems } = load();
if (problems.length && !force) {
  console.error(`the model has ${problems.length} problem(s); fix them or pass --force`);
  for (const p of problems.slice(0, 5)) console.error(`  ${p}`);
  process.exit(1);
}

const missing = ids.filter((id) => !byId.has(id));
if (missing.length) {
  console.error(`no such document: ${missing.join(", ")}`);
  process.exit(1);
}

// ---- expand: reports whose only subject is going away ----------------------
const doomed = new Set(ids);
let grew = true;
while (grew) {
  grew = false;
  for (const r of byId.values()) {
    if (doomed.has(r.id) || r.type !== "report") continue;
    const subjects = links.filter((l) => l.from === r.id && l.rel === "documents");
    if (subjects.length && subjects.every((l) => doomed.has(l.to))) {
      doomed.add(r.id);
      grew = true;
    }
  }
}

// ---- refuse on any reference we are not already removing -------------------
const blockers = [];
for (const l of links) {
  if (doomed.has(l.to) && !doomed.has(l.from)) blockers.push(`${l.from} —${l.rel}→ ${l.to}`);
  if (doomed.has(l.from) && !doomed.has(l.to)) blockers.push(`${l.from} —${l.rel}→ ${l.to}`);
}
for (const r of byId.values()) {
  if (!doomed.has(r.id) && r.parent_id && doomed.has(r.parent_id)) {
    blockers.push(`${r.id} has parent_id ${r.parent_id}`);
  }
}

const cascaded = [...doomed].filter((id) => !ids.includes(id));
console.log(`removing ${doomed.size} document(s):\n`);
for (const id of [...doomed].sort((a, b) => Number(a) - Number(b))) {
  const r = byId.get(id);
  const why = ids.includes(id) ? "" : "  (cascade: nothing left to document)";
  console.log(`  ${id.padEnd(3)} ${r.type.padEnd(8)} ${r.title}${why}`);
}

if (blockers.length && !force) {
  console.error(`\nBLOCKED — ${blockers.length} reference(s) would dangle:\n`);
  for (const b of blockers) console.error(`  ${b}`);
  console.error(`\nRemove those documents too, or re-point them, or pass --force to drop the links.`);
  process.exit(1);
}
if (blockers.length) console.log(`\n--force: dropping ${blockers.length} link(s) that would dangle`);

if (dryRun) {
  console.log(`\n--dry-run: nothing changed.`);
  process.exit(0);
}

// ---- delete ---------------------------------------------------------------
const removed = [];
for (const id of doomed) {
  const r = byId.get(id);
  unlinkSync(join(DATA, "docs", `${id}.json`));
  removed.push(`docs/data/docs/${id}.json`);
  // prose lives under its SUBJECT's type and number, so a report's own entries
  // may point into a directory named for a different document; remove by path
  for (const e of r.entries ?? []) {
    if (!e.file) continue;
    const dir = join(DOCS, e.file, "..");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      removed.push(`docs/${e.file.replace(/\/[^/]+$/, "")}/`);
    }
  }
}

const prune = (file, keep) => {
  const p = join(DATA, file);
  if (!existsSync(p)) return 0;
  const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim());
  const kept = lines.filter((l) => { try { return keep(JSON.parse(l)); } catch { return true; } });
  writeFileSync(p, kept.length ? `${kept.join("\n")}\n` : "");
  return lines.length - kept.length;
};
const droppedLinks = prune("links.jsonl", (l) => !doomed.has(l.from) && !doomed.has(l.to));
const droppedTags = prune("tags.jsonl", (t) => !doomed.has(t.doc));

for (const r of removed) console.log(`\n  removed ${r}`);
console.log(`\n  ${droppedLinks} link row(s), ${droppedTags} tag row(s) pruned`);
console.log(`\nIDs are NOT reused — the next document continues the sequence, so a
number in an old commit message still means what it meant.

  npm run docs:check`);
