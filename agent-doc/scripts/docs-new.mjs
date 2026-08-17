// scripts/docs-new.mjs
//
// Files a new resource. THE ID IS ASSIGNED, NEVER TYPED.
//
//   npm run docs:new -- task "Add the import pipeline" --area core
//   npm run docs:new -- rule "Every write goes through the queue" --area core --status proposed
//   npm run docs:new -- note "measured the baseline" --area core --type measurement --on TASK-001
//   npm run docs:new -- report "Baseline measurement" --area core --on TASK-001 --prose
//
// Why a command and not a convention: "read the real maximum before filing" is
// a rule people and agents both break. A prose index of the highest ID in use
// goes stale silently — several conflicting claims at once — and then a document
// gets filed at a number already taken. A tool that scans the directory cannot
// be wrong about it; a human reading a number quoted in prose can.
//
// `--on <ID>` writes the link row too, so a note or report is never orphaned —
// the second half of filing that is easy to forget.

import { existsSync, mkdirSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import { areas, carriesEntries, docTypes, noteTypes, priorities } from "../docs/taxonomy.mjs";
import { DOCS, SUMMARY_PLACEHOLDER, load } from "./docs-lib.mjs";

const DATA = join(DOCS, "data");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return !v || v.startsWith("--") ? true : v;
}

const [, , kind, title] = process.argv;
const spec = docTypes[kind];

if (!spec || !title || title.startsWith("--")) {
  console.error(`usage: npm run docs:new -- <${Object.keys(docTypes).join("|")}> "<title>" [options]

  --area <${Object.keys(areas).join("|")}>   required
  --status <s>     defaults to the first status for the type
  --priority <p>   free text
  --on <ID>        link this to an existing resource (notes annotate, reports document)
  --kind <k>       notes only: ${Object.keys(noteTypes).join(" | ")}
  --parent <ID>    file this as a child of an existing document
  --source <sys>   asana | github | linear | figma  (default local)
  --url <url>      the external url, with --source
  --prose          also create a prose file under reports/ and reference it`);
  process.exit(1);
}

/** The next free number, read from the directory — never from a quoted claim. */
function nextId() {
  const dir = join(DATA, "docs");
  mkdirSync(dir, { recursive: true });
  const used = readdirSync(dir)
    .map((f) => /^(\d+)\.json$/.exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  const n = (used.length ? Math.max(...used) : 0) + 1;
  return { id: String(n), n };
}

const area = arg("area");
if (!(area in areas)) {
  console.error(`--area must be one of: ${Object.keys(areas).join(", ")}`);
  process.exit(1);
}
const status = arg("status", Object.keys(spec.status)[0]);
if (!(status in spec.status)) {
  console.error(`--status for a ${kind} must be one of: ${Object.keys(spec.status).join(", ")}`);
  process.exit(1);
}

const { id, n } = nextId();
const num = String(n);

const body = { id, type: kind, title, status };
const prio = arg("priority");
if (prio && prio !== true) {
  if (!(prio in priorities)) {
    console.error(`--priority must be one of: ${Object.keys(priorities).join(", ")}`);
    process.exit(1);
  }
  body.priority = prio;
}
const src = arg("source");
if (src && src !== true) body.source = { system: src, ...(arg("url") ? { url: arg("url") } : {}) };
if (kind === "note") {
  const t = arg("kind", "comment");
  if (!(t in noteTypes)) {
    console.error(`--kind must be one of: ${Object.keys(noteTypes).join(", ")}`);
    process.exit(1);
  }
  body.kind = t;
  body.at = new Date().toISOString().slice(0, 10);
}
if (carriesEntries(kind)) {
  body.at = new Date().toISOString().slice(0, 10);
  body.entries = [];
}

const parent = arg("parent");
if (parent && parent !== true) body.parent_id = String(parent).replace(/\D/g, "");

const created = [];

// Prose goes under reports/<type-dir>/<number>/, never inline in the JSON.
//
// For anything that is not itself a report, `--prose` also mints the REPORT that
// holds it and links it back. Otherwise the file is an orphan: written, but
// referenced by nothing and invisible to `docs:show` — which is exactly what
// happened the first time this command was used.
let proseReport = null;
if (arg("prose") === true) {
  const rel = join("reports", kind, num, "index.md");
  mkdirSync(join(DOCS, "reports", kind, num), { recursive: true });
  // The stub carries the summary blockquote, because a convention that lives
  // only in the skill is one an author has to remember; one that is already in
  // the file is one they only have to fill in.
  writeFileSync(join(DOCS, rel), `# ${title}\n\n> ${SUMMARY_PLACEHOLDER}\n\n_Write the reasoning here._\n`);
  created.push(`docs/${rel}`);

  if (carriesEntries(kind)) {
    body.entries.push({ type: "prose", note: title, file: rel });
  } else {
    const rid = String(n + 1);
    writeFileSync(join(DATA, "docs", `${rid}.json`), `${JSON.stringify({
      id: rid, type: "report", title, status: "draft",
      at: new Date().toISOString().slice(0, 10),
      entries: [{ type: "prose", note: title, file: rel }],
    }, null, 2)}\n`);
    proseReport = rid;
    created.push(`docs/data/docs/${rid}.json`);
  }
}

if (proseReport) {
  appendFileSync(join(DATA, "links.jsonl"), `${JSON.stringify({ from: proseReport, rel: "documents", to: id })}\n`);
  created.push(`docs/data/links.jsonl  (+ ${proseReport} documents ${id})`);
}

// area is a TAG, not a field — a doc may carry several
appendFileSync(join(DATA, "tags.jsonl"), `${JSON.stringify({ doc: id, axis: "area", value: area })}\n`);
if (proseReport) {
  appendFileSync(join(DATA, "tags.jsonl"), `${JSON.stringify({ doc: proseReport, axis: "area", value: area })}\n`);
}

const path = join(DATA, "docs", `${id}.json`);
writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
created.push(`docs/data/docs/${id}.json`);

// the link, so nothing is filed orphaned
const on = arg("on");
if (on && on !== true) {
  const { byId } = load();
  if (!byId.has(on)) {
    console.error(`--on ${on} does not exist; the resource was written but not linked`);
  } else {
    const rel = kind === "note" ? "annotates" : kind === "report" ? "documents" : "relates_to";
    appendFileSync(join(DATA, "links.jsonl"), `${JSON.stringify({ from: id, rel, to: on })}\n`);
    created.push(`docs/data/links.jsonl  (+ ${id} ${rel} ${on})`);
  }
}

console.log(`${kind}/${id} — ${title}\n`);
for (const c of created) console.log(`  ${c}`);
console.log(`\n  npm run docs:show -- --id ${id}`);
