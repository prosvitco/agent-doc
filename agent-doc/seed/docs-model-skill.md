# Read and file documentation

> All documentation here is one normalised model, not a folder of markdown.
> Nine commands cover reading, filing, updating, linking, removing and
> validating it, and the ID is always minted, never typed.

All documentation in this tree is **one normalised model**, not a folder of
markdown. Eight commands cover everything; you never need the schema, you never
hand-assemble a document from the JSON, and you never hand-edit it either.

## Read

```bash
npm run docs:show                     # everything, priority-ordered
npm run docs:show -- --id task-k3f9x2 # one document, fully assembled
npm run docs:show -- --id k3f         # any unambiguous prefix resolves
npm run docs:show -- --type rule      # one type
npm run docs:show -- --area core    # one area, across all types
npm run docs:show -- --status open --type task
npm run docs:show -- --on task-k3f9x2 # everything linked to a document
npm run docs:show -- --type rule --summary   # + what each one says
```

The list is the **index** — id, filed date, type, status, priority, areas,
title, ordered by priority and then oldest first. Add
`--summary` and each row also carries what that document *says*, which is the
form to reach for when triaging rather than looking something up.

`docs:show --id` is **the entry point**. It returns the document with its
fields, its prose, its notes, its evidence reports and both link directions
already joined. A normalised model is right for writing and wrong for reading —
this command is the reading side.

## File

```bash
npm run docs:new -- task "Short imperative title" --area core --priority high
npm run docs:new -- note "What was measured" --area core --kind measurement --on k3f
npm run docs:new -- rule "The invariant, stated" --area core --prose
```

**The ID is minted, never typed.** It looks like `task-k3f9x2`: the type, then
six characters of entropy. Filing at an id quoted in prose is how the system this
replaced ended up with four different stale "highest ID" claims in one index, and
a task filed on an id that was already taken.

It is *not* a counter, and that is the point. A counter is read per branch, so
two branches filing at once both pick the same next number — and the damage is
not the file conflict, which git catches, but `links.jsonl` and `tags.jsonl`,
which merge cleanly and silently re-attach one document's history to another.

You rarely type a whole id: **any unambiguous prefix works**, so `k3f` is
usually enough, and an ambiguous one lists its candidates rather than guessing.

Useful flags: `--on <id>` writes the relationship row too, so nothing is filed
orphaned; `--parent <id>` files a subtask; `--prose` creates the content file
(and, for a type that cannot hold content itself, the report that holds it plus
the link).

**IDs are never reused, ever.** `docs/data/ids.jsonl` records every id ever
minted and nothing prunes it — not `docs:rm`, not clearing the model — so an id
in an old commit message, an old branch or a prose paragraph keeps meaning what
it meant. It is also where a two-branch collision surfaces: both branches append
the same line, the merge keeps both, and `docs:check` names it.

**Every document records `at`, the day it was filed.** Ids carry no order, so
the date is a real field rather than something the numbering implied, and it is
what the index sorts on.

## Summarise it in the prose, in one sentence

**The first blockquote under a prose file's heading is that document's
summary.** `docs:show --summary` lifts it under each row of a listing,
`docs:show --id` prints it at the top, and `docs:query` gets it as the `summary`
column — so a search can match what a document *says*.

```markdown
# The invariant, stated

> One sentence saying what this document establishes, and the measurement
> behind it, for someone deciding whether to read on.

The reasoning starts here…
```

It lives in the prose and **not** as a JSON field, for one reason: a summary
kept in another file is a second copy of the content that nothing can check.
Three lines above what it compresses, it is edited by whoever edits the prose
and it appears in the same diff.

`docs:new --prose` writes the placeholder into the stub. An unfilled placeholder
counts as **absent**, and `docs:check` then names the documents that have prose
but no summary — as a line in its ok output, not a failure. Requiring one would
get it filled with a restated title, which is "26 spellings of done" in a new
place; a document whose whole content is one sentence has nothing to compress,
and its title is the honest answer.

## Update

```bash
npm run docs:set -- 10 --status landed --note "what moved and why"
npm run docs:set -- 10 --priority high
```

Fields only — `status` and `priority`. Titles, areas and links are not fields;
areas and links are pivot rows, and bundling them would turn a small command
into a general editor.

`--status` is validated against **that document's own type**, because each type
owns its status enum. The value then has to survive the whole model: `docs:set`
re-loads after writing and **reverts** if the change broke something a single
field cannot see — a task cannot be `landed` while it is still `blocked_on`
anything. A value that is already wrong is not a blocker, because repairing one
is a use for this command.

**The note is offered, never required.** `--note` files the note, its
`annotates` row and its area tag in one step, so recording the transition is
cheaper than skipping it; a status change without one prints the `docs:new`
command that files it afterwards. Requiring it was rejected: which transitions
are significant is not something the taxonomy declares, so the rule would be a
closed vocabulary living outside `taxonomy.mjs` — and a mandatory field with
nothing to say gets filled cheaply, which is how the system this replaced
accumulated 26 spellings of "done". A trail of empty notes is worse than none,
because it looks like an audit trail.

Editing the JSON by hand is not *dangerous* — the validator refuses a bad value
and both readers go through it, and a field change has no cascade, which is why
`docs:rm` is mandatory and this is not. The command exists because the JSON was
the last hand-editing surface and it sat on the path every task takes, where the
enum was discoverable only by getting it wrong and nothing ever asked for the
trail.

## Link

```bash
npm run docs:link -- 21 relates_to 28        # read it as a sentence
npm run docs:link -- 21 relates_to 28 --rm
```

`docs:new --on` writes a link too, but only at the moment a document is filed
and only *from* the new one; `docs:set` moves fields and never touches pivots.
This is the remaining case — **two documents that already exist and turn out to
be related** — which was the last thing still done by hand, on the path ordinary
work takes.

The rel vocabulary is **printed before any write**: ask for nothing, or get it
wrong, and you get `linkRels` with what each one means, because choosing between
`relates_to` and `implements` is the real decision and `taxonomy.mjs` was the
only place it was written down.

Four refusals, each of them something the pivot cannot say for itself — a
missing end, a self-link, a second `supersedes` on one source, and an **exact
duplicate**: the pivot has no key, so the same row appended twice is accepted
and then rendered twice in both directions. Then, exactly as `docs:set` does, it
re-loads and **reverts** if the write broke a whole-model invariant — a
`blocked_on` onto a landed task, or a `--rm` that leaves a report with nothing
to document.

`parent_id` is not here. Hierarchy is a *field*, validated as a tree, not a row
in the pivot — it belongs to `docs:set` if anywhere.

## Remove

```bash
npm run docs:rm -- 9 11 --dry-run     # print the plan, change nothing
npm run docs:rm -- 9 11               # delete
```

A document is four things in three places — a JSON file, tag rows, link rows in
both directions, and a directory of prose. Deleting the JSON by hand leaves the
other three, and the model's own checks then fail on files nobody touched.
Always use the command.

**Cascade is not a flag.** A report must `documents` something, so deleting a
document necessarily deletes any report whose only subject was that document —
leaving it would produce a model that cannot validate. It happens automatically
and is printed. Anything *else* pointing at a target blocks and names itself: a
dangling reference is a decision for a person, not a default.

## Check and query

```bash
npm run docs:check                    # validate the whole model — CI runs this
npm run docs:query -- --open          # canned: open work by priority
npm run docs:query "SELECT …"         # anything the flags cannot express
```

`docs:query` builds a SQLite index from the JSON and queries it. **The database
is derived and gitignored**; the JSON is the source. That split keeps `git
diff`, `git blame` and reviewable change on the most valuable artefact — the
record of what was rejected and why — while still allowing joins and aggregates.

The schema is a second, independent line of defence: enums are foreign-key
tables, so the database rejects a vocabulary the validator let through. That has
already caught a real bug the validator passed.

## The model

| | |
|---|---|
| `docs/data/docs/<n>.json` | one file per document, **small** — structure only |
| `docs/data/links.jsonl` | the one pivot: `{from, rel, to}` |
| `docs/data/tags.jsonl` | the other pivot: `{doc, axis, value}` |
| `docs/reports/<type>/<n>/` | the large content — prose, images, data |
| `docs/taxonomy.mjs` | **every closed vocabulary**, single source |

Four decisions, each of which was a fork:

**Relationships are a pivot, never an embedded array.** An array denormalises
the fact: the reverse direction has to be recomputed, and two copies of one fact
can disagree. One row is one fact.

**The pivots are JSONL.** One fact per line means git merges two people's links
cleanly instead of conflicting on a reformatted array.

**Large content is a file, never a JSON string.** Forty lines of reasoning
inside a string field is escaped newlines — unreadable in a diff and painful to
write, which is exactly the part with the most value.

**One `doc` resource with a `type` field**, not a resource kind per type. Adding
a type is an entry in `taxonomy.mjs` — but only where the code asks about
capabilities; see below.

## Rules for changing the model

**Never edit an enum in prose.** `taxonomy.mjs` is the single source; every
table of values elsewhere is derived. In the system this replaced, `status` was
free text and accumulated 26 spellings of "done", so every reader had to guess
with a regex.

**Ask a capability, never a type name.** When `guide` was added, three places
tested `type === "report"` by name. The guide's prose validated clean and then
rendered nowhere and indexed nothing, with every check green. `carriesEntries()`
reads the `requires: ["entries"]` the taxonomy already declares. **A type that
validates is not a type that works — render it and query it before believing
it.**

**Both ends of a link must exist.** Not be *mentioned* — exist. An earlier
validator scanned for mentions, so a typo'd id validated itself, because the
file naming it was inside the scanned tree.

**A report must document something.** A report is evidence *for* something; if
it stands alone it is a `guide`. Without that check the model silently accepts
the wrong type — which is exactly how it was found.

**Check that content is durable, not merely present.** A bare `reports/` line in
`.gitignore`, written for something else entirely, matched `docs/reports/` and
left every prose file in the model untracked for days. The JSON was in git; the
reasoning it pointed at was not, and nothing failed — `docs:check` asserts a
file exists on disk, and it did. Everything valuable here lives under a
directory name that is very likely to appear in someone's ignore file.

## Passing it on

```bash
npm run docs:seed -- ../another-project
```

Copies the taxonomy, the scripts and the explaining skill from `seed/`, and
writes an empty model. Seed assets live outside `docs/` on purpose: clearing the
model must not be able to delete the thing that explains it. Everything is
portable except `areas` — that axis is the project's own layers, so edit it in
`taxonomy.mjs` first and file nothing until it is right. Plain ESM,
`node:sqlite`, **no dependencies**.
