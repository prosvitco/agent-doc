// scripts/docs-migrate.mjs
//
// Moves a database off the old integer ids and onto `<type>-<suffix>`.
//
//   npm run docs:migrate -- --dry-run    print the plan, change nothing
//   npm run docs:migrate                 do it
//
// Run once, commit the result. It is idempotent — a second run finds nothing to
// do — and safe to run on a branch, for the reason in the next section.
//
// THE IDS ARE DERIVED, NOT ROLLED
//
// `docs:new` mints with entropy, because a counter cannot survive two branches.
// A migration must NOT: if two people migrate the same database on two branches
// with random ids, every document gets two identities and the merge is beyond
// saving — strictly worse than the collision this whole change exists to fix.
//
// So a migrated id is a hash of what the document already is (`deriveId`), and
// the whole run is a pure function of the input database. Same database in,
// byte-identical database out, on any machine, in any order, any number of
// times. A stale branch can migrate itself and merge cleanly with a trunk that
// migrated last week.
//
// WHAT IS RECOVERED, AND WHAT CANNOT BE
//
//   `at` — every document now needs the day it was filed, because ids no longer
//   carry order. It is read from `git log --diff-filter=A`: the commit that
//   ADDED the file. Nothing is invented, and the index keeps the order it had.
//
//   Old numbers in PROSE cannot be rewritten. "supersedes the approach in task
//   11" is English, and no rewriter can tell it from "11 tests failed". So they
//   are left alone, `docs/data/legacy-ids.jsonl` records where each number went,
//   every command resolves through it, and this prints the paragraphs to review.

import { execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

import { docTypes } from "../docs/taxonomy.mjs";
import { DATA, DOCS, ROOT, deriveId, load, today } from "./docs-lib.mjs";

const dryRun = process.argv.includes("--dry-run");
const DOCDIR = join(DATA, "docs");

const git = (args) => {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
};

// ---- is there anything to do? ----------------------------------------------
//
// Asked FIRST, before the preconditions. The guards below are about protecting a
// rewrite of every file, and there is nothing to protect if no file is going to
// move — a template repo with no model of its own should hear "nothing to
// migrate", not "commit your work first".
const DOCDIR_FILES = existsSync(DOCDIR) ? readdirSync(DOCDIR).filter((f) => f.endsWith(".json")) : [];
const legacyDocs = DOCDIR_FILES.filter((f) => /^\d+\.json$/.test(f)).map((f) => f.replace(/\.json$/, ""));

if (!legacyDocs.length) {
  console.log(DOCDIR_FILES.length
    ? `nothing to migrate — ${DOCDIR_FILES.length} document(s) already use \`<type>-<suffix>\` ids.`
    : `nothing to migrate — there is no model here.`);
  process.exit(0);
}

// ---- refuse unless the escape hatch is real --------------------------------
//
// This rewrites nearly every file in the model. Three preconditions, and none of
// them is bureaucracy:
//
//   GIT, for two things this cannot do without: reading the day each document
//   was filed, and giving you an undo for a change this size.
//
//   A CLEAN TREE, so `git diff` is the entire review surface and `git checkout`
//   is an undo that needs no cooperation from this script.
//
//   A VALID MODEL, because migrating broken data buries the breakage inside a
//   200-file diff where nobody will ever find it. Fix it first, on small diffs.
if (git(["rev-parse", "--git-dir"]) === null) {
  console.error(`not a git repository.

The migration needs git for two things it cannot do without: reading the day
each document was filed (\`git log --diff-filter=A\`), and giving you an undo
for a change this size. Initialise one, commit the current model, then re-run.`);
  process.exit(1);
}
if (!dryRun && (git(["status", "--porcelain"]) ?? "").trim()) {
  console.error(`working tree is not clean.

Commit or stash first. This rewrites almost every file under docs/, and that
diff is only reviewable if it is the ONLY diff — and \`git checkout -- .\` is
only an undo if there is nothing else for it to throw away.

  npm run docs:migrate -- --dry-run    # the plan, without touching anything`);
  process.exit(1);
}

// The four complaints this command EXISTS to answer. `load()` validates against
// the new rules, so an unmigrated database necessarily fails them — refusing on
// its own to-do list would make the command unrunnable. Everything else still
// blocks, which is the part that matters: those are the problems that would
// vanish into a rewrite of every file.
const MIGRATABLE = [
  /is not a valid id/,
  /id says '.*' but type is/,
  /not recorded in ids\.jsonl/,
  /no 'at' —/,
];

const model = load();
const blocking = model.problems.filter((p) => !MIGRATABLE.some((re) => re.test(p)));
if (blocking.length) {
  console.error(`the model has ${blocking.length} problem(s) — fix them BEFORE migrating:\n`);
  for (const p of blocking) console.error(`  ${p}`);
  console.error(`
Migrating invalid data hides the breakage in a rewrite of every file. Each of
these is a small diff today and a needle in a haystack afterwards.`);
  process.exit(1);
}

// Numeric order, so `deriveId`'s collision salting is deterministic: the same
// database always resolves a collision the same way, on any machine.
legacyDocs.sort((a, b) => Number(a) - Number(b));

/**
 * The one id chosen rather than derived.
 *
 * A seeded project's first document is the skill that explains the model, and
 * INSTALL.md, AGENTS.md and `docs:seed`'s own closing instructions all name it
 * by id. Those lines are written before the database exists, so the id has to be
 * the same in every install — which a hash of a per-project title is not.
 * Recognised by all three of its seeded properties, so a project that reused the
 * number for something else is not silently swept into it.
 */
const SEED_ID = "skill-docs-model";
const isSeedDoc = (r) =>
  r.id === "1" && r.type === "skill" && r.title === "Read and file documentation";

const raw = new Map(legacyDocs.map((id) => [id, JSON.parse(readFileSync(join(DOCDIR, `${id}.json`), "utf8"))]));

const taken = new Set([SEED_ID]);
const map = new Map();
for (const oldId of legacyDocs) {
  const r = raw.get(oldId);
  const id = isSeedDoc(r) ? SEED_ID : deriveId(r.type, oldId, r.title, taken);
  taken.add(id);
  map.set(oldId, id);
}

/** The day the file entered git — the order the integer id used to imply. */
function filedOn(oldId) {
  const path = relative(ROOT, join(DOCDIR, `${oldId}.json`));
  const out = git(["log", "--diff-filter=A", "--format=%ad", "--date=short", "-1", "--", path]);
  return (out ?? "").trim().split("\n")[0] || null;
}

// ---- the plan -------------------------------------------------------------
const at = new Map();
for (const oldId of legacyDocs) {
  at.set(oldId, raw.get(oldId).at ?? filedOn(oldId) ?? today());
}

/** `reports/<type>/<n>/…` → `reports/<type>/<new-id>/…`, by the id in the path. */
function movedProse(file) {
  const m = /^reports\/([^/]+)\/(\d+)(\/.*)$/.exec(file);
  if (!m) return null;
  const to = map.get(m[2]);
  return to ? `reports/${m[1]}/${to}${m[3]}` : null;
}

const proseMoves = new Map(); // old dir (relative to docs/) → new dir
const unmapped = [];
for (const r of raw.values()) {
  for (const e of r.entries ?? []) {
    if (!e.file) continue;
    const to = movedProse(e.file);
    if (!to) { unmapped.push(e.file); continue; }
    proseMoves.set(dirname(e.file), dirname(to));
  }
}

console.log(`${legacyDocs.length} document(s) to migrate:\n`);
const w = Math.max(...legacyDocs.map((id) => id.length));
for (const oldId of legacyDocs) {
  const r = raw.get(oldId);
  const note = isSeedDoc(r) ? "  (the seeded skill — fixed id)" : "";
  const gained = r.at ? "" : `  +at ${at.get(oldId)}`;
  console.log(`  ${oldId.padEnd(w)} → ${map.get(oldId).padEnd(18)} ${r.type.padEnd(8)} ${r.title}${gained}${note}`);
}
if (proseMoves.size) {
  console.log(`\n${proseMoves.size} prose directory/ies:\n`);
  for (const [from, to] of proseMoves) console.log(`  docs/${from}/ → docs/${to}/`);
}
if (unmapped.length) {
  console.log(`\n${unmapped.length} prose path(s) NOT of the form reports/<type>/<n>/ — left where they are:\n`);
  for (const f of unmapped) console.log(`  docs/${f}`);
}

if (dryRun) {
  console.log(`\n--dry-run: nothing changed. The ids above are DERIVED — an actual run
produces exactly these, on any machine, however many times it runs.`);
  process.exit(0);
}

// ---- snapshot, so the undo needs nothing from git --------------------------
//
// Every file this touches is remembered as it was, along with whether it existed
// at all. If verification fails the snapshot is put back — no `git checkout`, no
// `git clean` deciding on its own which of your untracked files to delete.
const snapshot = new Map();
const remember = (abs) => {
  if (!snapshot.has(abs)) snapshot.set(abs, existsSync(abs) ? readFileSync(abs) : null);
};
const created = [];

function restore() {
  for (const [abs, body] of snapshot) {
    if (body === null) { if (existsSync(abs)) rmSync(abs, { force: true }); }
    else { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, body); }
  }
  for (const dir of created.reverse()) {
    if (existsSync(dir) && !readdirSync(dir).length) rmSync(dir, { recursive: true, force: true });
  }
}

/** Move a directory, remembering every file inside it so `restore` can undo. */
function moveDir(fromRel, toRel) {
  const from = join(DOCS, fromRel);
  const to = join(DOCS, toRel);
  if (!existsSync(from)) return;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else { remember(p); remember(join(to, relative(from, p))); }
    }
  };
  walk(from);
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
  created.push(to);
}

const LINKS = join(DATA, "links.jsonl");
const TAGS = join(DATA, "tags.jsonl");
const LEDGER = join(DATA, "ids.jsonl");
const LEGACY = join(DATA, "legacy-ids.jsonl");

try {
  for (const rel of new Set(proseMoves.keys())) moveDir(rel, proseMoves.get(rel));

  for (const oldId of legacyDocs) {
    const id = map.get(oldId);
    const body = { ...raw.get(oldId), id, at: at.get(oldId) };
    if (body.parent_id !== undefined) body.parent_id = map.get(String(body.parent_id)) ?? body.parent_id;
    body.entries = (body.entries ?? []).map((e) => (e.file ? { ...e, file: movedProse(e.file) ?? e.file } : e));
    if (!body.entries.length) delete body.entries;

    // Field order is rebuilt so `id` and `at` sit where they do in a freshly
    // filed document; the diff is already total, so it may as well land tidy.
    const ordered = {};
    for (const k of ["id", "type", "title", "status", "priority", "source", "at", "kind", "parent_id", "entries"]) {
      if (body[k] !== undefined) ordered[k] = body[k];
    }
    for (const k of Object.keys(body)) if (ordered[k] === undefined) ordered[k] = body[k];

    const from = join(DOCDIR, `${oldId}.json`);
    const to = join(DOCDIR, `${id}.json`);
    remember(from);
    remember(to);
    rmSync(from, { force: true });
    writeFileSync(to, `${JSON.stringify(ordered, null, 2)}\n`);
  }

  // The pivots, line by line — an unmapped id is left verbatim so verification
  // catches it by name rather than this quietly writing `undefined`.
  const remap = (file, keys) => {
    if (!existsSync(file)) return;
    remember(file);
    const out = readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((line) => {
      const row = JSON.parse(line);
      for (const k of keys) if (row[k] !== undefined && map.has(String(row[k]))) row[k] = map.get(String(row[k]));
      return JSON.stringify(row);
    });
    writeFileSync(file, out.length ? `${out.join("\n")}\n` : "");
  };
  remap(LINKS, ["from", "to"]);
  remap(TAGS, ["doc"]);

  // The ledger has to exist before verification: `load()` fails a live document
  // that no ledger row records, because that is an id `mintId` could reissue.
  remember(LEDGER);
  const ledgerRows = [...new Set([...(existsSync(LEDGER) ? readFileSync(LEDGER, "utf8").split("\n") : [])
    .filter((l) => l.trim()).map((l) => JSON.parse(l).id)])];
  const rows = [...ledgerRows.map((id) => ({ id, at: null })), ...legacyDocs.map((o) => ({ id: map.get(o), at: at.get(o) }))]
    .filter((r, i, a) => a.findIndex((x) => x.id === r.id) === i)
    .map((r) => JSON.stringify({ id: r.id, at: r.at ?? at.get(legacyDocs[0]) ?? today() }));
  writeFileSync(LEDGER, `${rows.join("\n")}\n`);

  remember(LEGACY);
  const legacyRows = [...map].map(([o, n]) => JSON.stringify({ old: o, new: n }));
  writeFileSync(LEGACY, `${(existsSync(LEGACY) ? readFileSync(LEGACY, "utf8").trim() : "")}\n${legacyRows.join("\n")}\n`.trimStart());

  // ---- verify: same model, different names ---------------------------------
  //
  // Not "does it validate" — a model that lost half its links validates fine.
  // The migrated model must be ISOMORPHIC to the one that went in: every
  // document, link and tag present, carrying the same values, with every id
  // mapped. Anything short of that puts the snapshot back.
  const after = load();
  const trouble = [...after.problems];

  if (after.byId.size !== model.byId.size) {
    trouble.push(`document count changed: ${model.byId.size} → ${after.byId.size}`);
  }
  for (const [oldId, before] of model.byId) {
    const id = map.get(oldId) ?? oldId;
    const now = after.byId.get(id);
    if (!now) { trouble.push(`${oldId} → ${id}: missing after the rewrite`); continue; }
    for (const k of ["type", "title", "status", "priority", "kind"]) {
      if (before[k] !== now[k]) trouble.push(`${id}: ${k} changed — '${before[k]}' → '${now[k]}'`);
    }
    const wantParent = before.parent_id === undefined ? undefined : map.get(String(before.parent_id)) ?? before.parent_id;
    if (wantParent !== now.parent_id) trouble.push(`${id}: parent_id '${now.parent_id}' should be '${wantParent}'`);
    if ((before.entries ?? []).length !== (now.entries ?? []).length) {
      trouble.push(`${id}: entry count changed`);
    }
  }
  const key = (o) => JSON.stringify(o);
  const wantLinks = model.links.map((l) => key({ from: map.get(l.from) ?? l.from, rel: l.rel, to: map.get(l.to) ?? l.to })).sort();
  const gotLinks = after.links.map((l) => key({ from: l.from, rel: l.rel, to: l.to })).sort();
  if (key(wantLinks) !== key(gotLinks)) {
    trouble.push(`links changed: ${model.links.length} in, ${after.links.length} out`);
    for (const l of wantLinks.filter((x) => !gotLinks.includes(x))) trouble.push(`  lost link ${l}`);
  }
  const wantTags = model.tags.map((t) => key({ doc: map.get(t.doc) ?? t.doc, axis: t.axis, value: t.value })).sort();
  const gotTags = after.tags.map((t) => key({ doc: t.doc, axis: t.axis, value: t.value })).sort();
  if (key(wantTags) !== key(gotTags)) trouble.push(`tags changed: ${model.tags.length} in, ${after.tags.length} out`);

  if (trouble.length) {
    restore();
    console.error(`\nREVERTED — the migration did not preserve the model:\n`);
    for (const t of trouble) console.error(`  ${t}`);
    console.error(`\nEverything is back as it was. Nothing was committed, nothing was lost.`);
    process.exit(1);
  }
} catch (e) {
  restore();
  console.error(`\nREVERTED — ${e.message}\n\nEverything is back as it was.`);
  process.exit(1);
}

// ---- prose: reported, never rewritten -------------------------------------
//
// A number in a sentence is not a reference this script can recognise. "task 11"
// and "11 tests failed" are the same token, and a rewriter confident enough to
// change the first will eventually change the second. So the paragraphs are
// printed and a person decides — and until they do, the ids still resolve
// through legacy-ids.jsonl, so nothing is broken in the meantime.
const mentions = [];
const scan = (dir) => {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) scan(p);
    else if (/\.(md|markdown)$/.test(name)) {
      readFileSync(p, "utf8").split("\n").forEach((line, n) => {
        const hits = [...line.matchAll(/\b(\d{1,4})\b/g)].map((m) => m[1]).filter((d) => map.has(d));
        if (hits.length) mentions.push({ file: relative(ROOT, p), line: n + 1, text: line.trim(), hits: [...new Set(hits)] });
      });
    }
  }
};
scan(join(DOCS, "reports"));

console.log(`\nmigrated ${legacyDocs.length} document(s).\n`);
console.log(`  docs/data/docs/            renamed`);
console.log(`  docs/data/links.jsonl      ${model.links.length} row(s) remapped`);
console.log(`  docs/data/tags.jsonl       ${model.tags.length} row(s) remapped`);
console.log(`  docs/data/ids.jsonl        the ledger — every id, so none is ever reissued`);
console.log(`  docs/data/legacy-ids.jsonl ${map.size} row(s) — old number → new id`);

if (mentions.length) {
  console.log(`\n${mentions.length} line(s) of prose mention a number that used to be an id.
NOT rewritten — a number in a sentence may be a count. Each still resolves
(\`docs:show -- --id 11\`), so this is a cleanup, not a breakage:\n`);
  for (const m of mentions.slice(0, 25)) {
    console.log(`  ${m.file}:${m.line}  [${m.hits.map((h) => `${h}→${map.get(h)}`).join(", ")}]`);
    console.log(`    ${m.text.slice(0, 100)}`);
  }
  if (mentions.length > 25) console.log(`\n  …and ${mentions.length - 25} more`);
}

console.log(`
Review it as one diff, then commit it alone:

  git diff --stat
  npm run docs:check
  git add -A && git commit -m "docs: migrate to <type>-<suffix> ids"

Every branch filed before this should REBASE onto that commit rather than
merging into it — the ids are derived, so a branch that migrates itself produces
identical ids and merges cleanly either way, but a rebase keeps one migration
commit in the history instead of two.`);
