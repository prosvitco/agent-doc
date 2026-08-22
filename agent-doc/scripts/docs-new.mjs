// scripts/docs-new.mjs
//
// Files a new resource. THE ID IS ASSIGNED, NEVER TYPED.
//
//   npm run docs:new -- task "Add the import pipeline" --area core
//   npm run docs:new -- rule "Every write goes through the queue" --area core --status proposed
//   npm run docs:new -- note "measured the baseline" --area core --kind measurement --on task-k3f9x2
//   npm run docs:new -- report "Baseline measurement" --area core --on task-k3f9x2 --prose
//
// Why a command and not a convention: an id has to be unique, and "check what is
// already taken before filing" is a rule people and agents both break. A prose
// index of ids in use goes stale silently — several conflicting claims at once —
// and then a document gets filed at an id already held.
//
// The id is `<type>-<six characters of entropy>`, minted against the ledger of
// every id ever used and claimed with an exclusive create, so two agents filing
// at the same moment cannot both win. `docs-id.mjs` carries that argument in
// full, including why a counter could not survive two branches.
//
// `--on <ID>` writes the link row too, so a note or report is never orphaned —
// the second half of filing that is easy to forget.

import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import { areas, carriesEntries, docTypes, noteTypes, priorities } from "../docs/taxonomy.mjs";
import { DATA, DOCS, SUMMARY_PLACEHOLDER, claimId, load, recordId, resolveOrExit, today } from "./docs-lib.mjs";

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
                   any unambiguous id prefix works — \`k3f\` for \`task-k3f9x2\`
  --kind <k>       notes only: ${Object.keys(noteTypes).join(" | ")}
  --parent <ID>    file this as a child of an existing document
  --source <sys>   asana | github | linear | figma  (default local)
  --url <url>      the external url, with --source
  --prose          also create a prose file under reports/ and reference it`);
  process.exit(1);
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

// Load once, up front: `--parent` and `--on` name documents that must already
// exist, and both are resolved before anything is written. Resolving after the
// claim would mean a typo leaves a filed document behind to clean up.
const { byId } = load();

const parentArg = arg("parent");
// No digit-stripping. The old line was `String(parent).replace(/\D/g, "")`,
// which turned any non-numeric id into nonsense — it was already wrong for the
// `TASK-001` form this file's own usage text advertised.
const parentId = parentArg && parentArg !== true ? resolveOrExit(parentArg, byId) : undefined;

const onArg = arg("on");
const onId = onArg && onArg !== true ? resolveOrExit(onArg, byId) : undefined;

// Claim the id by creating the file exclusively — nothing else can hold it from
// here on, so the prose directory named after it is safe to create.
const { id, path } = claimId(kind);
const at = today();

const body = { id, type: kind, title, status, at };
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
}
if (carriesEntries(kind)) body.entries = [];

if (parentId) body.parent_id = parentId;

const created = [];

// Prose goes under reports/<type>/<ID>/, never inline in the JSON.
//
// The directory is named for the id now, not a number. Under the counter the
// name and the owning document could already disagree — the directory took the
// SUBJECT's number while the report holding it was filed at `n + 1` — and
// `docs:rm` had to carry a comment explaining that. One id, one directory.
//
// For anything that is not itself a report, `--prose` also mints the REPORT that
// holds it and links it back. Otherwise the file is an orphan: written, but
// referenced by nothing and invisible to `docs:show` — which is exactly what
// happened the first time this command was used.
let proseReport = null;
if (arg("prose") === true) {
  const rel = join("reports", kind, id, "index.md");
  mkdirSync(join(DOCS, "reports", kind, id), { recursive: true });
  // The stub carries the summary blockquote, because a convention that lives
  // only in the skill is one an author has to remember; one that is already in
  // the file is one they only have to fill in.
  writeFileSync(join(DOCS, rel), `# ${title}\n\n> ${SUMMARY_PLACEHOLDER}\n\n_Write the reasoning here._\n`);
  created.push(`docs/${rel}`);

  if (carriesEntries(kind)) {
    body.entries.push({ type: "prose", note: title, file: rel });
  } else {
    // Claimed the same way, never guessed. The old line was `String(n + 1)` —
    // an assumption that the next number was free, which held only because
    // nothing else ran in between.
    const { id: rid, path: rpath } = claimId("report");
    writeFileSync(rpath, `${JSON.stringify({
      id: rid, type: "report", title, status: "draft", at,
      entries: [{ type: "prose", note: title, file: rel }],
    }, null, 2)}\n`);
    recordId(rid, at);
    proseReport = rid;
    created.push(`docs/data/docs/${rid}.json`, `docs/data/ids.jsonl  (+ ${rid})`);
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

// The file already exists — `claimId` created it empty to hold the id. This
// fills it in.
writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
recordId(id, at);
created.push(`docs/data/docs/${id}.json`);
created.push(`docs/data/ids.jsonl  (+ ${id})`);

// the link, so nothing is filed orphaned
if (onId) {
  const rel = kind === "note" ? "annotates" : kind === "report" ? "documents" : "relates_to";
  appendFileSync(join(DATA, "links.jsonl"), `${JSON.stringify({ from: id, rel, to: onId })}\n`);
  created.push(`docs/data/links.jsonl  (+ ${id} ${rel} ${onId})`);
}

console.log(`${kind}/${id} — ${title}\n`);
for (const c of created) console.log(`  ${c}`);
console.log(`\n  npm run docs:show -- --id ${id}`);
