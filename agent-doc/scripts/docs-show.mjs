// scripts/docs-show.mjs
//
// Reads the model: one resource assembled in full, or a filtered list.
//
//   npm run docs:show -- --id 2                    one document, assembled
//   npm run docs:show 2                            positional shortcut
//   npm run docs:show -- --type task               every task
//   npm run docs:show -- --type task --status open filtered
//   npm run docs:show -- --area core               across all types
//   npm run docs:show -- --on 2                    everything linked to it
//   npm run docs:show -- --type task --summary     with each document's summary
//
// IDs are ONE global sequence with `type` as a field, so `2`, `002` and `0002`
// all resolve. The type is not in the id because it is already a column.
//
// THIS IS THE AGENT ENTRY POINT. A normalised model is right for writing and
// wrong for reading: nobody should need the schema, five file reads and a join
// to see one task. One command returns the assembled document — fields, prose,
// notes, reports and both link directions — or the list, without SQL.
//
// `docs:query` remains for questions these flags cannot express.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { areas, carriesEntries, docTypes, linkRels, noteTypes, priorities } from "../docs/taxonomy.mjs";
import { DOCS, load, proseFileOf, relationsOf, summaryOf } from "./docs-lib.mjs";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return !v || v.startsWith("--") ? true : v;
}

const positional = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : undefined;
const type = arg("type");
const idArg = arg("id") ?? positional;
const withProse = !process.argv.includes("--no-prose");
// The list is the INDEX — id, type, status, priority, areas, title — and stays
// that way by default. Summaries roughly double its line count, and this is the
// command every session opens with, so the cost is paid on every run to serve
// the runs that are triaging. `--summary` asks for them when that is the job.
const withSummary = process.argv.includes("--summary");

if (type && !(type in docTypes)) {
  console.error(`--type must be one of: ${Object.keys(docTypes).join(", ")}`);
  process.exit(1);
}

const { byId, links, problems } = load();
if (problems.length) {
  console.error(`docs — ${problems.length} problem(s); run \`npm run docs:check\`\n`);
  for (const p of problems.slice(0, 5)) console.error(`  ${p}`);
  process.exit(1);
}

/** `001` + `--type task` resolves to TASK-001; a full id resolves as itself. */
function resolveId(raw) {
  if (!raw || raw === true) return undefined;
  if (byId.has(raw)) return raw;
  // ids are one global zero-padded sequence, so `7`, `007` and `0007` all mean
  // the same document — an agent should not have to know the padding
  const n = String(raw).replace(/\D/g, "");
  return byId.has(n) ? n : undefined;
}

// ---------------------------------------------------------------------------
// One resource, assembled
// ---------------------------------------------------------------------------

/** `21` → `design/21 — Layer 2 …`, so a link reads without a second lookup. */
function describe(id) {
  const d = byId.get(id);
  return d ? `${d.type}/${d.id} — ${d.title}` : id;
}

function showOne(r) {
  const out = [];
  out.push(`# ${r.type}/${r.id} — ${r.title}`, "");
  out.push(
    `\`${r.type}\` · \`${r.status}\` · ${r.areas.map((a) => `\`${a}\``).join(" ")}` +
      (r.priority ? ` · **${r.priority}**` : "") +
      (r.source && r.source.system !== "local"
        ? ` · from **${r.source.system}**${r.source.url ? ` ([source](${r.source.url}))` : ""}`
        : ""),
  );
  // The summary is lifted from the prose, so it is printed ONCE — here, above
  // the links, where it is read before deciding whether to read on — and
  // stripped from the body below rather than shown twice.
  const summary = summaryOf(r, byId, links);
  const ledeFile = summary ? proseFileOf(r, byId, links) : undefined;
  if (summary) out.push("", `> ${summary}`);

  const children = [...byId.values()].filter((x) => x.parent_id === r.id);
  if (r.parent_id || children.length) {
    out.push("", "## Hierarchy", "");
    if (r.parent_id) {
      const p = byId.get(r.parent_id);
      out.push(`- parent: ${p ? `${p.type}/${p.id} — ${p.title}` : r.parent_id}`);
    }
    for (const c of children) out.push(`- child: ${c.type}/${c.id} — ${c.title}`);
  }

  const { out: outLinks, in: inLinks } = relationsOf(r.id, links);
  if (outLinks.length || inLinks.length) {
    out.push("", "## Relationships", "");
    // NAME the other end. A bare `relates_to → 28` costs a second command to
    // find out what 28 is, and a document carrying several links then hides an
    // ordering in its id numbers — which is how the architecture's reading
    // order became a prose table in the first place.
    for (const l of outLinks) out.push(`- **${l.rel}** → ${describe(l.to)} — *${linkRels[l.rel]}*`);
    for (const l of inLinks) out.push(`- ${describe(l.from)} — **${l.rel}** → this`);
  }

  const notes = inLinks
    .filter((l) => l.rel === "annotates")
    .map((l) => byId.get(l.from))
    .filter(Boolean)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  if (notes.length) {
    out.push("", "## Notes", "");
    for (const n of notes) {
      out.push(`### ${n.at ?? "—"} · ${n.kind ?? "note"} — ${n.title}`, "");
      if (n.kind) out.push(`*${noteTypes[n.kind]}*`, "");
      const s = summaryOf(n, byId, links);
      if (s) out.push(s, "");
    }
  }

  // A document's OWN entries. Reports reach a reader through an inbound
  // `documents` link, but a guide, skill or design note IS the content — its
  // entries hang off itself, and rendering only the linked case made 66 lines of
  // imported prose invisible while every check stayed green.
  if (carriesEntries(r.type) && (r.entries ?? []).length) {
    out.push("", "## Contents", "");
    entries(out, r.entries, ledeFile);
  }

  for (const l of inLinks.filter((x) => x.rel === "documents")) {
    const rep = byId.get(l.from);
    if (!rep) continue;
    out.push("", `## Report ${rep.id} — ${rep.title}`, "");
    entries(out, rep.entries ?? [], ledeFile);
  }
  return out.join("\n");
}

/** Drop the lede blockquote — it was already printed as the summary. */
function withoutLede(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(">"));
  if (start < 0 || lines.slice(0, start).some((l) => l.startsWith("##"))) return text;
  let end = start;
  while (end < lines.length && lines[end].startsWith(">")) end++;
  while (end < lines.length && !lines[end].trim()) end++;
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

function entries(out, list, ledeFile) {
  for (const e of list) {
    if (e.type === "metric") out.push(`- **${e.name}**: ${e.value}${e.unit ?? ""} — ${e.note ?? ""}`);
    else if (e.type === "link") out.push(`- [${e.note ?? e.url}](${e.url})`);
    else if (e.type === "prose" && withProse) {
      const p = join(DOCS, e.file);
      if (!existsSync(p)) out.push("", `_missing: ${e.file}_`, "");
      else {
        const text = readFileSync(p, "utf8");
        out.push("", (e.file === ledeFile ? withoutLede(text) : text).trim(), "");
      }
    } else out.push(`- \`${e.type}\` ${e.note ?? ""} — \`docs/${e.file}\``);
  }
}

// ---------------------------------------------------------------------------
// A filtered list
// ---------------------------------------------------------------------------

/**
 * Wrap to at most two lines, ellipsising only if a third would be needed.
 *
 * Truncating at one line cut every summary mid-sentence, which is the failure
 * this whole feature exists to fix — an index that shows half a thought costs a
 * second command exactly as a bare title does.
 */
function wrapped(text, width, maxLines = 2) {
  const lines = [];
  let cur = "";
  for (const word of text.split(" ")) {
    if (cur && cur.length + word.length + 1 > width) { lines.push(cur); cur = ""; }
    cur = cur ? `${cur} ${word}` : word;
    if (lines.length === maxLines) return [...lines.slice(0, -1), `${lines.at(-1).slice(0, width - 1)}…`];
  }
  return [...lines, cur];
}

function table(rows) {
  if (!rows.length) return "(no matches)";
  const cols = ["id", "type", "status", "priority", "areas", "title"];
  const val = (r, c) => (c === "areas" ? r.areas.join(",") : r[c]);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(val(r, c) ?? "").length)));
  const line = (cells) => cells.map((c, i) => String(c ?? "").padEnd(w[i])).join("  ");

  // The summary goes on its own line under the row, NOT in a seventh column —
  // a column would push the table past any terminal to save one line each.
  //
  // It is indented a fixed four spaces rather than aligned under the title
  // column: aligning looked tidier and left ~50 characters of room, because one
  // 150-character title pads that column for every row. Alignment is worth
  // nothing if what it aligns is cut mid-word.
  const room = Math.max(60, (process.stdout.columns || 120) - 6);

  // A report's prose IS its subject's prose, so its summary is the same string.
  // Printing both is 17 duplicate lines in a 39-row list. Suppressed only when
  // the subject is on screen too — under `--type report` the summary is the
  // only thing distinguishing the rows, and there it stays.
  const shown = new Set(rows.map((r) => r.id));
  const echoesSubject = (r) =>
    r.type === "report" && links.some((l) => l.from === r.id && l.rel === "documents" && shown.has(l.to));

  const body = [];
  for (const r of rows) {
    body.push(line(cols.map((c) => val(r, c))));
    if (!withSummary || echoesSubject(r)) continue;
    const s = summaryOf(r, byId, links);
    if (s) body.push(...wrapped(s, room).map((l) => `    ${l}`));
  }
  return [line(cols), w.map((n) => "-".repeat(n)).join("  "), ...body].join("\n");
}

const single = resolveId(idArg);
if (single) {
  console.log(showOne(byId.get(single)));
  process.exit(0);
}
if (idArg && idArg !== true) {
  console.error(`no such resource: ${idArg}${type ? ` (type ${type})` : ""}`);
  process.exit(1);
}

const area = arg("area");
if (area && area !== true && !(area in areas)) {
  console.error(`--area must be one of: ${Object.keys(areas).join(", ")}`);
  process.exit(1);
}
const status = arg("status");
const on = arg("on");

let rows = [...byId.values()];
if (type) rows = rows.filter((r) => r.type === type);
if (area && area !== true) rows = rows.filter((r) => r.areas.includes(area));
if (status && status !== true) rows = rows.filter((r) => r.status === status);
if (on && on !== true) {
  const linked = new Set(links.filter((l) => l.to === on || l.from === on).flatMap((l) => [l.from, l.to]));
  linked.delete(on);
  rows = rows.filter((r) => linked.has(r.id));
}
// priority first (by rank, unset last), then id numerically
const rank = (r) => priorities[r.priority]?.rank ?? 99;
rows.sort((a, b) => rank(a) - rank(b) || Number(a.id) - Number(b.id));

console.log(table(rows));
// The footer advertises `--summary`, because a flag nobody knows about is a
// feature nobody has: the index is where you would be standing when you want it.
console.log(
  `\n${rows.length} of ${byId.size} · \`npm run docs:show -- --id <ID>\` for one in full` +
    (withSummary ? "" : " · `--summary` for what each one says"),
);
