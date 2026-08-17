// scripts/docs-seed.mjs
//
// Copies this documentation model into another project.
//
//   npm run docs:seed -- ../other-project
//   npm run docs:seed -- ../other-project --force
//
// WHAT TRAVELS AND WHAT DOES NOT
//
// The scripts, the taxonomy and the "how to use it" skill travel. The DATA does
// not — a new project starts with an empty model and one document, the skill
// that explains it, so `docs:show` answers something on the first run rather
// than printing an empty table.
//
// `areas` is the one part of the taxonomy that is project-specific: it is that
// project's own layers, not a general vocabulary. The seed rewrites it to a
// placeholder and says so loudly, because a stale area list inherited from
// another codebase is worse than no area list — it validates, so nothing ever
// prompts anyone to fix it.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/** Seed assets live OUTSIDE docs/, so clearing the model cannot delete them. */
const SKILL = join(ROOT, "seed", "docs-model-skill.md");
const AGENTS_EXAMPLE = join(ROOT, "AGENTS.md.example");

const SCRIPTS = [
  "docs-lib.mjs", "docs-show.mjs", "docs-new.mjs", "docs-set.mjs", "docs-link.mjs",
  "docs-check.mjs", "docs-db.mjs", "docs-query.mjs", "docs-rm.mjs", "docs-seed.mjs",
];

const SCRIPT_ENTRIES = {
  "docs:show": "node scripts/docs-show.mjs",
  "docs:new": "node scripts/docs-new.mjs",
  "docs:set": "node scripts/docs-set.mjs",
  "docs:link": "node scripts/docs-link.mjs",
  "docs:check": "node scripts/docs-check.mjs",
  "docs:db": "node scripts/docs-db.mjs",
  "docs:query": "node scripts/docs-query.mjs",
  "docs:rm": "node scripts/docs-rm.mjs",
  "docs:seed": "node scripts/docs-seed.mjs",
};

/** areas is the project's own layers — never inherited from another codebase. */
const PLACEHOLDER_AREAS = `export const areas = {
  // EDIT THESE FIRST. An area is one of THIS project's layers, and the list is
  // closed — \`docs:check\` rejects anything else, and every document must carry
  // at least one. Inheriting another project's areas is worse than having none:
  // they validate, so nothing ever prompts anyone to fix them.
  core: "replace me",
  workflow: "tooling, docs, entry points",
};`;

const target = process.argv[2];
const force = process.argv.includes("--force");

if (!target || target.startsWith("--")) {
  console.error(`usage: npm run docs:seed -- <target-project-dir> [--force]

Copies the docs model — scripts, taxonomy, and the skill that explains it — into
another project. Data does not travel; the target starts empty.`);
  process.exit(1);
}

if (!existsSync(SKILL)) {
  console.error(`missing seed asset: ${SKILL}

This file is the explanation a new project starts with, and it is NOT part of
the docs model — \`docs:rm\` cannot reach it and clearing the model does not
remove it. If it is gone, someone deleted seed/ by hand; restore it from git
rather than seeding a project with no explanation in it.`);
  process.exit(1);
}

const dest = resolve(process.cwd(), target);
if (!existsSync(dest)) {
  console.error(`no such directory: ${dest}`);
  process.exit(1);
}

const destDocs = join(dest, "docs");
if (existsSync(join(destDocs, "data", "docs")) && !force) {
  console.error(`${destDocs}/data already has a model — pass --force to overwrite the scripts anyway`);
  process.exit(1);
}

const wrote = [];
const write = (rel, body) => {
  const p = join(dest, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  wrote.push(rel);
};

// ---- scripts, verbatim ----------------------------------------------------
mkdirSync(join(dest, "scripts"), { recursive: true });
for (const s of SCRIPTS) {
  copyFileSync(join(HERE, s), join(dest, "scripts", s));
  wrote.push(`scripts/${s}`);
}

// ---- the agent-instructions starting point --------------------------------
// A template for the TARGET project's root AGENTS.md: points agents at the
// model and tells providers to symlink (CLAUDE.md → AGENTS.md), never copy.
if (existsSync(AGENTS_EXAMPLE)) {
  copyFileSync(AGENTS_EXAMPLE, join(dest, "AGENTS.md.example"));
  wrote.push("AGENTS.md.example");
}

// ---- taxonomy, with `areas` blanked --------------------------------------
const taxonomy = readFileSync(join(ROOT, "docs", "taxonomy.mjs"), "utf8");
const start = taxonomy.indexOf("export const areas = {");
const end = taxonomy.indexOf("};", start) + 2;
if (start < 0 || end < 2) {
  console.error("could not locate `areas` in taxonomy.mjs — seed aborted rather than shipping a half-rewritten file");
  process.exit(1);
}
write("docs/taxonomy.mjs", taxonomy.slice(0, start) + PLACEHOLDER_AREAS + taxonomy.slice(end));

// ---- an empty model, plus the one document that explains it --------------
mkdirSync(join(destDocs, "data", "docs"), { recursive: true });
write("docs/data/links.jsonl", "");
write("docs/data/tags.jsonl", JSON.stringify({ doc: "1", axis: "area", value: "workflow" }) + "\n");
// The skill text is an ASSET OF THE SEED, not a live document. Read from a live
// document it would couple the boilerplate to one document id — deleting that
// document silently breaks seeding for every future project. It lives in seed/,
// outside docs/ entirely, so clearing the model cannot reach it.
write("docs/reports/skill/1/index.md", readFileSync(SKILL, "utf8"));
write("docs/data/docs/1.json", JSON.stringify({
  id: "1",
  type: "skill",
  title: "Read and file documentation",
  status: "current",
  at: new Date().toISOString().slice(0, 10),
  entries: [{ type: "prose", note: "How this model works", file: "reports/skill/1/index.md" }],
}, null, 2) + "\n");

// ---- package.json scripts, merged rather than replaced -------------------
const pkgPath = join(dest, "package.json");
let pkgNote;
if (existsSync(pkgPath)) {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.scripts = { ...(pkg.scripts ?? {}), ...SCRIPT_ENTRIES };
  if (pkg.type !== "module") pkg.type = "module";
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  pkgNote = "package.json — docs:* scripts merged in";
} else {
  write("package.json", JSON.stringify({
    name: dest.split("/").pop(), private: true, type: "module", scripts: SCRIPT_ENTRIES,
  }, null, 2) + "\n");
  pkgNote = null;
}

const gi = join(dest, ".gitignore");
const giBody = existsSync(gi) ? readFileSync(gi, "utf8") : "";
if (!giBody.includes(".docs.db")) {
  writeFileSync(gi, `${giBody}${giBody.endsWith("\n") || !giBody ? "" : "\n"}docs/data/.docs.db\n`);
  wrote.push(".gitignore — the derived DB");
}

console.log(`seeded ${dest}\n`);
for (const w of wrote) console.log(`  ${w}`);
if (pkgNote) console.log(`  ${pkgNote}`);
console.log(`
NEXT, in order:

  1. edit docs/taxonomy.mjs — replace \`areas\` with this project's layers
  2. npm run docs:check          # should pass with 1 resource
  3. npm run docs:show -- --id 1 # the skill explains the rest
  4. copy AGENTS.md.example to the project root as AGENTS.md, then symlink
     every provider file to it:  ln -s AGENTS.md CLAUDE.md

Nothing else needs installing: plain ESM, node:sqlite, no dependencies.`);
