// scripts/docs-rm.mjs
//
// Removes documents, and everything that only existed to support them.
//
//   npm run docs:rm -- task-k3f9x2 note-8mq04p   delete, with a plan printed first
//   npm run docs:rm -- k3f --dry-run             show the plan, change nothing
//   npm run docs:rm -- k3f --force               delete even if something links to it
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

import { DATA, DOCS, load, resolveOrExit } from "./docs-lib.mjs";

const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");
const targets = process.argv.slice(2).filter((a) => !a.startsWith("--"));

if (!targets.length) {
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

const ids = targets.map((t) => resolveOrExit(t, byId));

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
// Filing order, from the recorded date — ids carry no sequence any more.
const width = Math.max(...[...doomed].map((id) => id.length));
for (const id of [...doomed].sort((a, b) => String(byId.get(a).at).localeCompare(String(byId.get(b).at)))) {
  const r = byId.get(id);
  const why = ids.includes(id) ? "" : "  (cascade: nothing left to document)";
  console.log(`  ${id.padEnd(width)}  ${r.at}  ${r.type.padEnd(8)} ${r.title}${why}`);
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
// This claim used to be false. `nextId()` scanned the live directory for its
// maximum, so deleting the highest-numbered document handed its number straight
// back to the next one filed. Nothing is pruned from `docs/data/ids.jsonl` — not
// here, not anywhere — and `mintId` asks the ledger rather than the directory,
// which is what finally makes it true.
console.log(`\nIDs are NOT reused: docs/data/ids.jsonl keeps every id ever minted, and this
command does not prune it. An id in an old commit message, an old branch or a
prose paragraph still means what it meant.

  npm run docs:check`);
