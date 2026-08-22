// scripts/docs-check.mjs — validate the whole model. Exit 1 on any problem.
//
// Two passes. The first is the model's own integrity, in docs-lib. The second is
// DURABILITY: is the content actually going to survive?
//
// A bare `reports/` line in .gitignore — written for something else entirely —
// once matched docs/reports/ and left every prose file in this model untracked
// for days. The JSON was in git; the reasoning it pointed at was not. Nothing
// failed, because checking that a file EXISTS is not checking that it is KEPT,
// and it existed. Everything valuable here lives under a directory name very
// likely to appear in someone's ignore file, so this is checked, not remembered.

import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { DOCS, load, proseFileOf, summaryOf } from "./docs-lib.mjs";

const { byId, links, problems } = load();

const git = (args, input) => {
  try {
    // stderr is IGNORED, and that needs saying because the default is a trap:
    // `execFileSync` pipes stdout but lets the child's stderr through to the
    // parent's unless stdio is given explicitly. So every non-git target — the
    // throwaway directory INSTALL.md tells you to seed as a smoke test — printed
    // `fatal: not a git repository` above an ok result. The catch below already
    // treats that as "not this command's problem"; this stops it also being the
    // reader's problem.
    return execFileSync("git", args, { input, encoding: "utf8", cwd: DOCS, stdio: ["pipe", "pipe", "ignore"] });
  } catch (e) {
    if (e.status === 1) return ""; // "nothing matched" — the healthy case
    return null; // not a git repo, or git unavailable — not this command's problem
  }
};

/**
 * Prose the model points at that would NOT survive a clone.
 *
 * The condition is `ignored AND not tracked`, and both halves matter:
 *
 *   --no-index   `git check-ignore` skips tracked files by default, so without
 *                this it reports nothing and the check silently passes. That is
 *                exactly how the first version of this function failed — it
 *                looked correct and caught nothing.
 *   tracked      once a file is in the index git keeps it regardless of any
 *                pattern, so a matching rule is harmless. Flagging those would
 *                make the check noisy enough to be turned off.
 */
function undurableFiles() {
  const files = [];
  for (const r of byId.values()) {
    for (const e of r.entries ?? []) if (e.file) files.push(join(DOCS, e.file));
  }
  if (!files.length) return [];

  const ignored = git(["check-ignore", "--no-index", "--stdin"], files.join("\n"));
  if (ignored === null || !ignored.trim()) return [];

  const listed = git(["ls-files", "--", "."]) ?? "";
  const tracked = new Set(listed.split("\n").filter(Boolean).map((f) => join(DOCS, f)));

  return ignored.split("\n").filter(Boolean).filter((f) => !tracked.has(f));
}

for (const f of undurableFiles()) {
  problems.push(`${f}: referenced by the model but IGNORED by git — it will not survive a clone`);
}

if (problems.length) {
  console.error(`docs:check — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`docs:check — ok. ${byId.size} resource(s), ${links.length} link(s).`);

// Reported, not failed. A missing summary costs a reader one extra command; a
// REQUIRED summary costs the model its trustworthiness, because a mandatory
// field with nothing to say gets filled with a restated title and the index
// then lies at scale. Naming the documents makes it a two-minute fix for
// whoever cares; making it a gate would make it someone's chore.
const unsummarised = [...byId.values()]
  .filter((r) => proseFileOf(r, byId, links) && !summaryOf(r, byId, links))
  .map((r) => r.id);
if (unsummarised.length) {
  console.log(`  ${unsummarised.length} document(s) with prose have no summary written (a blockquote under the heading): ${unsummarised.join(" ")}`);
}
