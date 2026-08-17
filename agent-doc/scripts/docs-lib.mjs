// scripts/docs-lib.mjs
//
// Loads and validates the docs data model. Shared by every `docs:*` command, so
// the rules are enforced in exactly one place.
//
// THE MODEL
//
//   docs/data/<type>/<ID>.json    one file per resource; SMALL — structure only
//   docs/data/links.jsonl         the ONE pivot: {from, rel, to}
//   docs/reports/<type>/<n>/…     the large content: prose, images, code, data
//
// Three decisions worth restating, because each was a fork:
//
//   Relationships are a PIVOT, never an embedded array. An array on the resource
//   denormalises the fact: the reverse direction has to be recomputed, and two
//   copies of one fact can disagree. One `links.jsonl` row is one fact.
//
//   The pivot is JSONL, not JSON. One relationship per line means git merges two
//   people's links cleanly instead of conflicting on a reformatted array.
//
//   Large content is a FILE under `reports/`, never a JSON string. Forty lines of
//   reasoning inside a string field is escaped newlines — unreadable in a diff and
//   painful to write, which is exactly the part with the most value.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  areas,
  carriesEntries,
  docTypes,
  priorities,
  tagAxes,
  linkRels,
  noteTypes,
  reportEntryTypes,
  singularRels,
  sourceSystems,
} from "../docs/taxonomy.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DOCS = join(ROOT, "docs");
const DATA = join(DOCS, "data");

// `summary` is deliberately NOT here. A one-line overview is a compression of
// the prose, so it lives IN the prose file as a blockquote under the heading
// (see `summaryOf`) and is lifted from there. Held as a JSON field instead it
// would be a second copy of the content, in a different file, that nothing can
// check — which is the exact construction this model was built to retire.
const KNOWN_FIELDS = new Set([
  "id", "type", "title", "status", "priority", "source",
  "at", "kind", "entries", "parent_id",
]);

export function load() {
  const problems = [];
  const fail = (m) => problems.push(m);
  const byId = new Map();

  // ONE directory, one loader. The type is a field, not a directory — adding a
  // type is data in the taxonomy rather than another code path here.
  const dir = join(DATA, "docs");
  if (existsSync(dir)) {
    for (const file of readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).sort()) {
      let r;
      try {
        r = JSON.parse(readFileSync(join(dir, file), "utf8"));
      } catch (e) {
        fail(`${file}: invalid JSON — ${e.message}`);
        continue;
      }
      const id = file.replace(/\.json$/, "");
      const spec = docTypes[r.type];

      if (r.id !== id) fail(`${file}: id '${r.id}' does not match the filename`);
      if (!spec) {
        fail(`${file}: type '${r.type}' not one of ${Object.keys(docTypes).join(", ")}`);
        continue;
      }
      if (!r.title) fail(`${file}: no title`);
      if (!(r.status in spec.status)) {
        fail(`${file}: status '${r.status}' not valid for a ${r.type} — ${Object.keys(spec.status).join(", ")}`);
      }
      if (r.priority !== undefined && !(r.priority in priorities)) {
        fail(`${file}: priority '${r.priority}' not one of ${Object.keys(priorities).join(", ")}`);
      }
      for (const k of Object.keys(r)) {
        if (!KNOWN_FIELDS.has(k)) fail(`${file}: unknown field '${k}'`);
      }
      for (const req of spec.requires ?? []) {
        if (r[req] === undefined) fail(`${file}: a ${r.type} requires '${req}'`);
      }
      if (r.source && !(r.source.system in sourceSystems)) {
        fail(`${file}: source.system '${r.source.system}' is not a known system`);
      }
      if (r.type === "note" && r.kind && !(r.kind in noteTypes)) {
        fail(`${file}: note kind '${r.kind}' not one of ${Object.keys(noteTypes).join(", ")}`);
      }
      if (carriesEntries(r.type)) {
        for (const [i, e] of (r.entries ?? []).entries()) {
          if (!(e.type in reportEntryTypes)) {
            fail(`${file}: entry ${i} type '${e.type}' is not a report entry type`);
          } else if (e.type === "metric") {
            if (typeof e.value !== "number") fail(`${file}: entry ${i} metric has no numeric value`);
          } else if (e.type === "link") {
            if (!e.url) fail(`${file}: entry ${i} link has no url`);
          } else if (!e.file) {
            fail(`${file}: entry ${i} (${e.type}) must reference a file`);
          } else if (!existsSync(join(DOCS, e.file))) {
            fail(`${file}: entry ${i} file not found — docs/${e.file}`);
          }
        }
      }
      byId.set(id, { file, ...r });
    }
  }

  // ---- tags: a doc may carry SEVERAL values on an axis --------------------
  const tags = [];
  const tagFile = join(DATA, "tags.jsonl");
  if (existsSync(tagFile)) {
    readFileSync(tagFile, "utf8").split("\n").forEach((line, n) => {
      if (!line.trim()) return;
      let t;
      try { t = JSON.parse(line); } catch { return fail(`tags.jsonl:${n + 1}: invalid JSON`); }
      const where = `tags.jsonl:${n + 1}`;
      const axis = tagAxes[t.axis];
      if (!axis) fail(`${where}: axis '${t.axis}' not one of ${Object.keys(tagAxes).join(", ")}`);
      else if (!(t.value in axis)) fail(`${where}: '${t.value}' is not a valid ${t.axis}`);
      if (!byId.has(t.doc)) fail(`${where}: doc '${t.doc}' does not exist`);
      tags.push(t);
    });
  }
  for (const r of byId.values()) {
    r.areas = tags.filter((t) => t.doc === r.id && t.axis === "area").map((t) => t.value);
    if (r.areas.length === 0) fail(`${r.file}: no area — every document needs at least one`);
  }

  // ---- the pivot ---------------------------------------------------------
  const links = [];
  const linkFile = join(DATA, "links.jsonl");
  if (existsSync(linkFile)) {
    const lines = readFileSync(linkFile, "utf8").split("\n");
    lines.forEach((line, n) => {
      if (!line.trim()) return;
      let l;
      try {
        l = JSON.parse(line);
      } catch {
        return fail(`links.jsonl:${n + 1}: invalid JSON`);
      }
      const where = `links.jsonl:${n + 1}`;
      if (!(l.rel in linkRels)) fail(`${where}: rel '${l.rel}' not one of ${Object.keys(linkRels).join(", ")}`);
      // Both ends must be resources that EXIST — not ids merely mentioned
      // somewhere. A mention-scanning check lets a typo'd id validate itself,
      // because the file naming it is inside the scanned tree.
      if (!byId.has(l.from)) fail(`${where}: from '${l.from}' does not exist`);
      if (!byId.has(l.to)) fail(`${where}: to '${l.to}' does not exist`);
      if (l.from === l.to) fail(`${where}: self-link`);
      links.push(l);
    });
  }

  // ---- hierarchy: parent_id, validated as a tree ------------------------
  for (const r of byId.values()) {
    if (r.parent_id === undefined) continue;
    if (!byId.has(r.parent_id)) fail(`${r.file}: parent_id '${r.parent_id}' does not exist`);
    if (r.parent_id === r.id) fail(`${r.file}: is its own parent`);
  }
  for (const start of byId.keys()) {
    const seen = new Set([start]);
    let cur = byId.get(start)?.parent_id;
    while (cur && byId.has(cur)) {
      if (seen.has(cur)) {
        fail(`${byId.get(start).file}: parent_id cycle`);
        break;
      }
      seen.add(cur);
      cur = byId.get(cur).parent_id;
    }
  }

  // singular rels
  for (const rel of singularRels) {
    const seen = new Map();
    for (const l of links.filter((x) => x.rel === rel)) {
      if (seen.has(l.from)) fail(`links.jsonl: ${l.from} has more than one '${rel}'`);
      seen.set(l.from, l.to);
    }
  }
  // A REPORT is evidence FOR something, so it must document something. A report
  // with nothing to document is standalone reference — that is a `guide`, and
  // the distinction is the whole reason both types exist. Without this check a
  // free-floating reference page files cleanly as a report and loses its kind.
  for (const r of byId.values()) {
    if (r.type !== "report") continue;
    if (!links.some((l) => l.from === r.id && l.rel === "documents")) {
      fail(`${r.file}: a report must \`documents\` something — if it stands alone it is a guide`);
    }
  }

  // Finished resources must not still be blocked — by something UNFINISHED.
  //
  // The blocker's status is half the fact, and leaving it out made the check
  // demand a lie: a task blocked on a question could not be landed until the
  // `blocked_on` row was DELETED, even after the question was resolved. That
  // deletes the only record of what the work was waiting for, to satisfy a
  // validator — the exact "edit the data until the check passes" move this model
  // exists to make unnecessary. A resolved blocker is history, and history stays.
  const FINISHED = { task: "landed", rule: "active", question: "resolved" };
  for (const l of links.filter((x) => x.rel === "blocked_on")) {
    const from = byId.get(l.from);
    const to = byId.get(l.to);
    if (!from || !to) continue;
    // A type with no terminal status (design, skill, guide, note, report) is
    // never "finished", so blocking a landed task on one still fails. That is
    // deliberate: those types do not complete, so the block cannot have lifted.
    if (from.status === FINISHED[from.type] && to.status !== FINISHED[to.type]) {
      fail(`${from.file}: status=${from.status} but still blocked_on ${l.to} (${to.type}/${to.status})`);
    }
  }

  return { byId, links, tags, problems };
}

// ---------------------------------------------------------------------------
// The summary: authored in the prose, lifted by the reader
// ---------------------------------------------------------------------------
//
// THE CONVENTION: a blockquote directly under the document's heading, before
// the first `##`.
//
//     # The import pipeline
//
//     > Input is validated once, at the edge, and never re-checked downstream…
//
//     …the prose…
//
// Why a blockquote and not frontmatter or a JSON field:
//
//   It is a SECOND FACT ONLY IF IT LIVES SOMEWHERE ELSE. Sitting three lines
//   above the prose it summarises, it is edited by whoever edits the prose,
//   and a diff shows both together. A `summary:` field in the JSON is a copy in
//   another file that goes stale silently — the stale-index failure this whole
//   model replaced.
//
//   It degrades to nothing. Delete every script and the file still reads
//   correctly, because a lede under a heading is just good markdown. Anything
//   requiring a parser (frontmatter, an HTML comment) reads as debris.
//
// A document with no summary block falls back to its title. That is a real
// answer, not a defect: a note whose whole content is one sentence has nothing
// to compress, and forcing a summary there would produce restated titles —
// the "mandatory field with nothing to say" that `docs:set --note` refuses to
// become.

/**
 * What `docs:new --prose` writes into the stub.
 *
 * It is a real blockquote so the convention is visible at the moment of
 * writing rather than only in the skill — and `summaryOf` treats it as ABSENT,
 * so an unfilled stub is reported by `docs:check` instead of appearing in the
 * index as if someone had written it.
 */
export const SUMMARY_PLACEHOLDER =
  "_One sentence: what this document says. It becomes the index entry._";

/** The prose file a document's summary would live in: its own, or its report's. */
export function proseFileOf(r, byId, links) {
  const own = (r.entries ?? []).find((e) => e.type === "prose");
  if (own) return own.file;
  const report = links
    .filter((l) => l.rel === "documents" && l.to === r.id)
    .map((l) => byId.get(l.from))
    .find(Boolean);
  return (report?.entries ?? []).find((e) => e.type === "prose")?.file;
}

/**
 * The authored summary, or `undefined`.
 *
 * Only the blockquote under the H1 counts. A later blockquote is a pull-quote
 * in the argument, and lifting one of those would put a sentence in the index
 * that nobody wrote to be read alone.
 */
export function summaryOf(r, byId, links) {
  const file = proseFileOf(r, byId, links);
  if (!file || !existsSync(join(DOCS, file))) return undefined;
  const lines = readFileSync(join(DOCS, file), "utf8").split("\n");
  const quote = [];
  for (const line of lines) {
    if (line.startsWith("##")) break; // a section started; no lede was written
    if (line.startsWith(">")) quote.push(line.replace(/^>\s?/, ""));
    else if (quote.length) break; // the blockquote ended
  }
  const text = quote.join(" ").replace(/\s+/g, " ").trim();
  return !text || text === SUMMARY_PLACEHOLDER ? undefined : text;
}

/** Links out of and into a resource, so both directions come from one fact. */
export function relationsOf(id, links) {
  return {
    out: links.filter((l) => l.from === id),
    in: links.filter((l) => l.to === id),
  };
}
