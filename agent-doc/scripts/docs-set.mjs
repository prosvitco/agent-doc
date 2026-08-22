// scripts/docs-set.mjs
//
// Updates a field on an existing document — the model's Update, which it spent
// eight commands not having.
//
//   npm run docs:set -- task-k3f9x2 --status landed
//   npm run docs:set -- k3f --status landed --note "why it landed"     (prefix)
//   npm run docs:set -- k3f --priority high --status in-progress
//
// WHY THIS IS A COMMAND
//
// Not because a hand-edit corrupts anything — it does not, and that was measured
// before this was built. `status: "SHIPPED"` is refused by `docs:check` AND by
// the database builder, because the validation lives in one place (`docs-lib`)
// that both readers go through, and a field edit has no cascade: no links, tags
// or prose directories move when a status changes.
//
// It is a command because the JSON was the ONLY remaining hand-editing surface,
// and it sat on the path every task takes — `open` → `in-progress` → `landed`.
// Two costs follow from that, and this command is aimed at exactly those:
//
//   The enum was discoverable only by FAILING. `docs:new --status` prints the
//   valid values; a hand-edit prints them after you write a wrong one.
//
//   Nothing prompted for the trail. `docs:new -- note --kind status` exists
//   precisely to record a transition, and a hand-edit cannot ask for it.
//
// THE NOTE IS OFFERED, NEVER REQUIRED
//
// `--note` writes the status note, its `annotates` row and its area tag in one
// step, so recording the transition is cheaper than not recording it. It is not
// mandatory, for two reasons:
//
//   The taxonomy does not say which transitions are significant. Hard-coding
//   "terminal statuses require a note" would put a closed vocabulary in this
//   file instead of `taxonomy.mjs`, and would test type names rather than a
//   declared capability — both are things this model exists to prevent.
//
//   A required field with nothing to say gets filled cheaply. That is how the
//   system this replaced accumulated 26 spellings of "done": a trail of empty
//   notes is worse than no trail, because it LOOKS like an audit trail.
//
// So the field write always happens, and a status change without `--note` prints
// what is missing and the command that fixes it.
//
// SCOPE: `status` and `priority`. Title, area tags and links are deliberately
// out — tags and links are pivot ROWS, not fields, and bundling them turns a
// small command into a general editor.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { docTypes, priorities } from "../docs/taxonomy.mjs";
import { DATA, load, resolveId, resolveOrExit } from "./docs-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return !v || v.startsWith("--") ? true : v;
}

const target = process.argv[2];

if (!target || target.startsWith("--")) {
  console.error(`usage: npm run docs:set -- <id> [--status <s>] [--priority <p>] [--note "<why>"]

  <id>             full or any unambiguous prefix — \`k3f\` for \`task-k3f9x2\`

  --status <s>     validated against THIS document's type — each type owns its own enum
  --priority <p>   ${Object.keys(priorities).join(" | ")}
  --note "<why>"   file a note recording the change, linked to the document

Only fields. Titles, area tags and links are not fields — see \`docs:new\`.`);
  process.exit(1);
}

// Read the file directly rather than through `load()`, for two reasons: the
// loader decorates each document with `file` and `areas`, which are not fields
// and must not be written back; and a document whose CURRENT value is invalid is
// dropped by the loader before it is indexed — which is precisely the document
// this command has to be able to repair.
//
// Resolution is tried against the loaded model first, then falls back to a bare
// filename hit. The fallback is the whole point: a document with an unknown
// `type` never reaches `byId`, so a prefix cannot find it — and that document is
// exactly the one this command exists to repair. Requiring a full id to fix a
// broken document is a fair trade for being able to fix it at all.
const hit = resolveId(target, load().byId);
const id = hit.id ?? (existsSync(join(DATA, "docs", `${target}.json`)) ? target : resolveOrExit(target, load().byId));
if (hit.moved) console.error(`  note: ${hit.moved} is now ${id} (docs/data/legacy-ids.jsonl)`);
const path = join(DATA, "docs", `${id}.json`);
const original = readFileSync(path, "utf8");
const doc = JSON.parse(original);
const spec = docTypes[doc.type];
if (!spec) {
  console.error(`${id}.json: type '${doc.type}' is not one of ${Object.keys(docTypes).join(", ")}`);
  process.exit(1);
}

// ---- validate against the type's OWN vocabulary, up front -------------------
//
// The taxonomy is read, never restated. `status` is per-type on purpose:
// `landed` vs `active` vs `resolved` are not the same idea, and one shared enum
// is what pushes people back to free text.
const wanted = [];
const status = arg("status");
if (status !== undefined) {
  if (status === true || !(status in spec.status)) {
    console.error(`--status for a ${doc.type} must be one of: ${Object.keys(spec.status).join(", ")}`);
    for (const [k, v] of Object.entries(spec.status)) console.error(`  ${k.padEnd(12)} ${v}`);
    process.exit(1);
  }
  wanted.push(["status", status]);
}
const priority = arg("priority");
if (priority !== undefined) {
  if (priority === true || !(priority in priorities)) {
    console.error(`--priority must be one of: ${Object.keys(priorities).join(", ")}`);
    for (const [k, v] of Object.entries(priorities)) console.error(`  ${k.padEnd(12)} ${v.describes}`);
    process.exit(1);
  }
  wanted.push(["priority", priority]);
}
const note = arg("note");
if (note === true) {
  console.error(`--note takes the text of the note: --note "what changed and why"`);
  process.exit(1);
}
if (!wanted.length) {
  console.error(`nothing to set — pass --status and/or --priority.\n\n  npm run docs:show -- --id ${id}`);
  process.exit(1);
}

const changes = wanted.filter(([k, v]) => doc[k] !== v);
if (!changes.length) {
  console.log(`${doc.type}/${id} already has ${wanted.map(([k, v]) => `${k}=${v}`).join(", ")} — nothing written.`);
  process.exit(0);
}

// ---- write, then ask the model whether it is still valid -------------------
//
// Up-front validation covers the vocabulary; it cannot cover the invariants that
// span documents — a task cannot be `landed` while it is still `blocked_on`
// something. Those live in `docs-lib` and are only answerable by loading the
// whole model, so this writes, re-loads, and reverts if it made things worse.
// Reverting rather than warning means the command cannot leave the model less
// valid than it found it. Pre-existing problems are NOT a blocker: repairing a
// bad value written by hand is a use for this command, not a case to refuse.
const before = new Set(load().problems);

for (const [k, v] of changes) doc[k] = v;
writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);

const introduced = load().problems.filter((p) => !before.has(p));
if (introduced.length) {
  writeFileSync(path, original);
  console.error(`REVERTED — that change makes the model invalid:\n`);
  for (const p of introduced) console.error(`  ${p}`);
  console.error(`\n${id}.json is unchanged.`);
  process.exit(1);
}

const was = JSON.parse(original);
console.log(`${doc.type}/${id} — ${doc.title}\n`);
for (const [k, v] of changes) console.log(`  ${k.padEnd(9)} ${was[k] ?? "(unset)"} → ${v}`);

// ---- the trail -------------------------------------------------------------
//
// Filed by `docs:new`, spawned rather than reimplemented: it is the one filer,
// it assigns the id from the directory, and it writes the link row and the area
// tag as well. A second copy of that logic here is how the two would drift.
const statusChanged = changes.some(([k]) => k === "status");
const area = load().tags.find((t) => t.doc === id && t.axis === "area")?.value;
if (note) {
  if (!area) {
    console.error(`\n  the field was written, but ${id} has no area tag to inherit — note NOT filed`);
    process.exit(1);
  }
  console.log("");
  try {
    execFileSync(process.execPath, [
      join(HERE, "docs-new.mjs"), "note", note,
      "--area", area,
      // `status` records a transition and why; a field change that is not a
      // transition is an observation, which is what `comment` is for.
      "--kind", statusChanged ? "status" : "comment",
      "--on", id,
    ], { stdio: "inherit" });
  } catch {
    // The field is already written and valid; say so rather than letting a
    // filing failure read as though nothing happened.
    console.error(`
  THE FIELD WAS WRITTEN — only the note failed to file. It is not lost work,
  just unrecorded; file it directly:

  npm run docs:new -- note "why it moved" --kind ${statusChanged ? "status" : "comment"} --on ${id} --area ${area}`);
    process.exit(1);
  }
} else if (statusChanged) {
  // Naming the command that fixes it, filled in and runnable — NOT a repeat of
  // this one with `--note` added. That would now be a no-op: the field already
  // holds the new value, so re-running writes nothing and files nothing.
  console.log(`
  NO NOTE was recorded, and the trail is the reason the model holds status at
  all. Pass --note next time, or file it now — the same thing, after the fact:

  npm run docs:new -- note "why it moved" --kind status --on ${id} --area ${area ?? "<area>"}`);
}

console.log(`\n  npm run docs:check`);
