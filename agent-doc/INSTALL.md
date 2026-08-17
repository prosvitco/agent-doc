# agent-doc — install & configure

**This is a kit, not a project's documentation.** It is an empty copy of a
normalised documentation model aimed at AI agents as much as at people:
documents are filed through commands rather than by convention, IDs are
assigned rather than typed, and every vocabulary is closed and validated. No
data travels — a seeded project starts with an empty model and one skill
document, so `docs:show` answers something on the first run.

This file covers **install and configuration only**, and is deliberately not
named `README.md` so agents don't re-read it every session. How to *work* with
the model is documented where agents look: `AGENTS.md.example` (the quick
reference) and document 1, the skill (the full explanation).

No dependencies, no install step: plain ESM and `node:sqlite`. **Node 22.5 or
newer** — the derived index will not build on older runtimes.

## Install

The model lives in a single self-contained `agent-doc/` directory in the
target project — its own `package.json`, scripts and data, nothing merged into
the project's own files. From the target project's root:

```bash
mkdir agent-doc
node /path/to/agent-doc/scripts/docs-seed.mjs agent-doc
```

The seed writes `docs/data/.docs.db` into the target's `.gitignore` and
refuses to run over a directory that already has a model unless you pass
`--force`. Every script resolves its paths from its own location, so the
commands work from the project root via `--prefix`:

```bash
npm --prefix agent-doc run docs:check               # should pass with 1 resource
npm --prefix agent-doc run docs:show -- --id 1      # the skill explains the rest
```

Seeding into the project root (`docs-seed.mjs .`) also works — `docs:*` is
merged into the project's existing `package.json` rather than replacing it —
but then `docs/` and `scripts/` land next to the project's own files.

## Configure

**1. Edit `agent-doc/docs/taxonomy.mjs` first.** `areas` ships as
`core: "replace me"` because an area is one of *that* project's layers.
Inheriting another codebase's area list is worse than having none: it
validates, so nothing ever prompts anyone to fix it. Every other vocabulary in
that file — types, statuses, relationships, note kinds — is general and meant
to be kept.

**2. Wire up `AGENTS.md`.** The seed copies `AGENTS.md.example` next to the
model; it is the starting point for the project's root `AGENTS.md`, the single
instruction file for AI agents. At the project root:

```bash
cp agent-doc/AGENTS.md.example AGENTS.md    # then edit the project sections
ln -s AGENTS.md CLAUDE.md                   # Claude Code
ln -s AGENTS.md GEMINI.md                   # Gemini CLI
mkdir -p .github && ln -s ../AGENTS.md .github/copilot-instructions.md
```

Every provider-specific file is a **symlink, never a copy** — a copy drifts,
a symlink cannot.

## What is in the kit

| | |
|---|---|
| `scripts/` | the ten `docs-*.mjs` commands |
| `docs/taxonomy.mjs` | every closed vocabulary, with `areas` blanked |
| `docs/data/`, `docs/reports/` | an empty model plus `skill/1`, the explanation |
| `AGENTS.md.example` | starting point for the target project's `AGENTS.md` |
| `seed/docs-model-skill.md` | the source of that skill document — see below |

`docs-seed.mjs` writes the starting skill document from
`seed/docs-model-skill.md`, which sits **outside `docs/`** so that clearing
the model cannot delete it — `docs:rm` cannot reach it and `docs:check` does
not know it exists.

A project seeded by `docs-seed.mjs` does **not** receive `seed/`, so it cannot
seed onward; it gets the model, not the kit. This directory has the asset
precisely so that it can. Delete it and `docs-seed.mjs` fails loudly rather
than shipping a project with no explanation in it.

## Maintaining the kit

⚠️ **The skill text lives in two places here** — `seed/docs-model-skill.md`,
the asset that ships, and `docs/reports/skill/1/index.md`, this kit's own live
copy of it. Nothing detects when they disagree. Edit the seed asset, then copy
it across:

```bash
cp seed/docs-model-skill.md docs/reports/skill/1/index.md
```

Skip that and the kit keeps handing new projects an older explanation than the
one you just wrote, and the only symptom appears months later in someone
else's repository.

Verify any change by seeding a throwaway directory rather than trusting the
diff:

```bash
mkdir /tmp/seedcheck && node scripts/docs-seed.mjs /tmp/seedcheck
cd /tmp/seedcheck && npm run docs:check && npm run docs:new -- task "smoke" --area core
```

Projects already seeded do not track this kit; nothing links them back. To
bring one up to date, copy `scripts/` over its `scripts/` by hand.

⚠️ **Do not re-seed a live project with `--force`.** The flag is named for the
scripts, but the seed writes a fresh empty model too: it truncates
`docs/data/links.jsonl`, resets `tags.jsonl`, overwrites document `1`, and
resets `areas` in the taxonomy to the placeholder. On a project with real
documentation in it, that is data loss, not an upgrade.
