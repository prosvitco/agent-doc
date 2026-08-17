// scripts/docs-link.mjs
//
// Relates two documents that already exist — the pivot's own Create and Delete.
//
//   npm run docs:link -- 21 relates_to 28
//   npm run docs:link -- 21 relates_to 28 --rm
//
// WHY THIS IS A COMMAND
//
// `docs:new --on` writes a link, but only at the moment a document is filed and
// only FROM the new document. `docs:set` moves fields and deliberately does not
// touch pivots. So the ordinary case — two documents that already exist and turn
// out to be related — had no command at all, and the only way to record it was
// appending a line to `links.jsonl` by hand.
//
// That happened while folding the architecture into the model: fourteen links
// carrying the reading order were written by a throwaway script. It worked, and
// `docs:check` passed, which is exactly the problem. The argument for `docs:new`,
// `docs:set` and `docs:rm` is not that hand-editing corrupts data — it is that
// the hand-editing surface must not sit on the path ordinary work takes. Linking
// is on that path, and it carried the two costs that always follow:
//
//   The vocabulary was discoverable only by reading `taxonomy.mjs`. `linkRels` is
//   seven values with meanings that decide which one is right, and a hand-edit
//   asks for none of them.
//
//   The pivot has NO KEY. Appending the same row twice is silently accepted and
//   then rendered twice, and nothing in `docs:check` calls it a problem.
//
// SCOPE: rows in `links.jsonl`. `parent_id` looks like a relationship and is a
// FIELD on the document — hierarchy is a tree the loader validates for cycles,
// not a pivot row — so it belongs to `docs:set` if anywhere, and is a separate
// decision.

import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import { linkRels, singularRels } from "../docs/taxonomy.mjs";
import { DOCS, load } from "./docs-lib.mjs";

const DATA = join(DOCS, "data");
const LINKS = join(DATA, "links.jsonl");

const rm = process.argv.includes("--rm");
const [from, rel, to] = process.argv.slice(2).filter((a) => !a.startsWith("--"));

/** The enum, with what each one means — printed before any write, never after. */
function vocabulary() {
  console.error(`\n  rel must be one of:\n`);
  for (const [k, v] of Object.entries(linkRels)) {
    console.error(`    ${k.padEnd(13)} ${v}${singularRels.includes(k) ? "  (at most one per source)" : ""}`);
  }
}

if (!from || !rel || !to || !/^\d+$/.test(from) || !/^\d+$/.test(to)) {
  console.error(`usage: npm run docs:link -- <from> <rel> <to> [--rm]

  <from> <rel> <to>   read as a sentence: "21 relates_to 28"
  --rm                remove that row instead of writing it

Both ends must already exist. To file a NEW document already linked, use
\`docs:new --on <id>\`; to change a field, \`docs:set\`.`);
  vocabulary();
  process.exit(1);
}

if (!(rel in linkRels)) {
  console.error(`'${rel}' is not a relationship kind.`);
  vocabulary();
  process.exit(1);
}

// ---- both ends must EXIST — not be mentioned, exist ------------------------
//
// `docs:new --on` prints a warning and files the document anyway, because there
// the document is the point and the link is the extra. Here the link IS the
// whole command, so a missing end is a refusal: there is nothing else to keep.
const { byId, links, problems } = load();
const missing = [from, to].filter((id) => !byId.has(id));
if (missing.length) {
  console.error(`no such document: ${missing.join(", ")}

Both ends of a link must exist. \`docs:check\` would fail on the dangling row,
and the failure would name links.jsonl rather than whatever typed it.`);
  process.exit(1);
}
if (from === to) {
  console.error(`${from} cannot ${rel} itself.`);
  process.exit(1);
}

const label = (id) => `${byId.get(id).type}/${id} — ${byId.get(id).title}`;
const same = (l) => l.from === from && l.rel === rel && l.to === to;
const existing = links.filter(same);

if (!rm) {
  // The pivot has no key, so nothing downstream would object to a second copy of
  // one fact — it would just render twice, in both directions.
  if (existing.length) {
    console.error(`already recorded: ${from} —${rel}→ ${to}

  npm run docs:show -- --id ${from}`);
    process.exit(1);
  }
  // `supersedes` is singular on its source: two of them means the document was
  // replaced twice, which is a story the model cannot tell. `docs:check` catches
  // it after the fact; catching it here means never writing it.
  if (singularRels.includes(rel)) {
    const held = links.find((l) => l.from === from && l.rel === rel);
    if (held) {
      console.error(`${from} already ${rel} ${held.to} — '${rel}' may appear once on a source.

Remove that one first if it is wrong:

  npm run docs:link -- ${from} ${rel} ${held.to} --rm`);
      process.exit(1);
    }
  }
} else if (!existing.length) {
  console.error(`no such row: ${from} —${rel}→ ${to}

  npm run docs:show -- --id ${from}   # what it IS linked to`);
  process.exit(1);
}

// ---- write, then ask the model whether it is still valid -------------------
//
// Same contract as `docs:set`: the up-front checks cover this row on its own,
// and only a whole-model load can see what a row means for everything else — a
// `blocked_on` written onto a landed task, or a `--rm` that leaves a report with
// nothing to document. So write, re-load, and put the file back if the problem
// set grew. Pre-existing problems are not a blocker; repairing the model is a
// use for this command, not a case to refuse.
const before = new Set(problems);
const original = existsSync(LINKS) ? readFileSync(LINKS, "utf8") : "";

if (rm) {
  const kept = original.split("\n").filter((line) => {
    if (!line.trim()) return false;
    try { return !same(JSON.parse(line)); } catch { return true; }
  });
  writeFileSync(LINKS, kept.length ? `${kept.join("\n")}\n` : "");
} else {
  appendFileSync(LINKS, `${JSON.stringify({ from, rel, to })}\n`);
}

const introduced = load().problems.filter((p) => !before.has(p));
if (introduced.length) {
  writeFileSync(LINKS, original);
  console.error(`REVERTED — that ${rm ? "removal" : "link"} makes the model invalid:\n`);
  for (const p of introduced) console.error(`  ${p}`);
  console.error(`\nlinks.jsonl is unchanged.`);
  process.exit(1);
}

// The rel's own description, printed at the moment it is used: the difference
// between `relates_to` and `implements` is a decision, and this is the one place
// someone is holding both documents in mind.
console.log(rm
  ? `removed  ${from} —${rel}→ ${to}\n`
  : `${from} —${rel}→ ${to}\n\n  ${rel}: ${linkRels[rel]}\n`);
console.log(`  from  ${label(from)}`);
console.log(`  to    ${label(to)}`);
if (existing.length > 1) console.log(`\n  (${existing.length} identical rows removed — the pivot has no key)`);
console.log(`\n  npm run docs:show -- --id ${from}\n  npm run docs:check`);
