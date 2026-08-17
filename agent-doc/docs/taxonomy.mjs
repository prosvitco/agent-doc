// docs/taxonomy.mjs
//
// SINGLE SOURCE for every closed vocabulary in the docs data model.
//
// Read by `docs:*` to validate, query and render. Any list of these values in
// prose is DERIVED — change it here, then regenerate.
//
// Why a module and not prose: a closed list only stays closed if something
// machine-readable holds it. A free-text `status` field accumulates a dozen
// spellings of "done", and then every reader has to guess with a regex.

/**
 * Tag AXES. Each is a closed vocabulary, and a document may carry SEVERAL values
 * on an axis — held in `tags.jsonl` as {doc, axis, value}, a pivot like any other
 * relationship rather than an array on the document.
 *
 * `area` is not invented: these are the architecture's own layers, so a
 * document's areas are the layers it touches. Multi-valued because real work
 * crosses them — a schema change made to serve the API touches both.
 */
export const areas = {
  // EDIT THESE FIRST. An area is one of THIS project's layers, and the list is
  // closed — `docs:check` rejects anything else, and every document must carry
  // at least one. Inheriting another project's areas is worse than having none:
  // they validate, so nothing ever prompts anyone to fix them.
  core: "replace me",
  workflow: "tooling, docs, entry points",
};

/**
 * Resource types. Each is a JSON file under `docs/data/<dir>/`.
 *
 * Every one owns its OWN status enum, because the lifecycles genuinely differ —
 * `landed` vs `active` vs `resolved` are not the same idea, and a shared enum is
 * what pushes people back to free text.
 */
/** Id width per resource. Notes and reports accumulate fastest, so they get more. */
/**
 * Document TYPES. One generic `doc` resource with a type discriminator, rather
 * than a resource kind per type — adding a type is data here, not a code path.
 *
 * Each still owns its OWN status enum, because the lifecycles genuinely differ:
 * `landed` vs `active` vs `resolved` are not the same idea, and a shared enum is
 * what pushes people back to free text.
 */
export const docTypes = {
  task: {
    heading: "Tasks",
    blurb: "Units of work.",
    status: {
      open: "filed, not started",
      "in-progress": "partially built",
      landed: "complete",
      parked: "deferred, absorbed or superseded",
    },
  },
  rule: {
    heading: "Rules",
    blurb: "Invariants that must hold, each with the measurement that established it.",
    status: {
      proposed: "stated, not yet enforced anywhere",
      active: "enforced; a change that violates it is a defect",
      superseded: "replaced — a `supersedes` link says by what",
    },
  },
  question: {
    heading: "Questions",
    blurb: "Open decisions that block work, each with the options and their costs.",
    status: { open: "blocks work", resolved: "decided — a note records the decision" },
  },
  note: {
    heading: "Notes",
    blurb: "Append-only record: comment, status, measurement, decision, difference, rejection.",
    status: { recorded: "written; never edited, only superseded by a later note" },
    /** Notes carry a second axis; see `noteTypes`. */
    requires: ["kind"],
  },
  design: {
    heading: "Design notes",
    blurb: "Why the system is shaped this way — the fork, the alternatives, what each costs.",
    status: { current: "the shape we build to", stale: "overtaken; a note says what changed", superseded: "replaced — a `supersedes` link says by what" },
    requires: ["entries"],
  },
  skill: {
    heading: "Skills",
    blurb: "A procedure an agent executes: when to reach for it, the steps, how to tell it worked.",
    status: { current: "safe to follow", stale: "steps no longer match the code", retired: "kept for history" },
    requires: ["entries"],
  },
  guide: {
    heading: "Guides",
    blurb: "Standalone reference: how to do a thing, or what something is. Explains rather than evidences.",
    status: { current: "accurate now", stale: "known out of date — say what changed", retired: "kept for history" },
    requires: ["entries"],
  },
  report: {
    heading: "Reports",
    blurb: "A bundle of evidence — prose, images, code, metrics — held as files.",
    status: { draft: "being assembled", final: "complete" },
    requires: ["entries"],
  },
};

/** One global sequence, plain integers — `1`, `2`, `3`. No padding to know. */
export const ID_PAD = 1;

/**
 * Does this type carry its own content entries?
 *
 * Ask the CAPABILITY, never the type name. Adding `guide` looked like pure data
 * and was not: three places tested `type === "report"` by name, so a guide's
 * prose validated, then rendered nowhere and indexed nothing. `requires:
 * ["entries"]` already states the fact — this reads it instead of restating it,
 * which is what makes the next type actually free.
 */
export const carriesEntries = (type) => Boolean(docTypes[type]?.requires?.includes("entries"));

/**
 * Note kinds. A note is how the audit trail lives IN the data rather than only
 * in git history — intentional rather than incidental, and it survives a file
 * move or a rewrite.
 */
export const noteTypes = {
  comment: "an observation with no state change",
  status: "records a status transition and why",
  measurement: "a number and how it was obtained",
  decision: "a fork taken, with the alternatives and what they cost",
  difference: "what changed between two states, and what it means",
  rejection: "an approach measured and rejected — the do-not-retry ledger",
};

/**
 * Relationship kinds for the ONE pivot (`links.jsonl`). Every relationship in
 * the model is a row there — task→question, note→task, report→rule — because
 * notes and reports are resources like any other.
 *
 * Embedding a list on the resource instead would denormalise it: the reverse
 * direction has to be recomputed, and two copies of one fact can disagree.
 */
export const linkRels = {
  blocked_on: "the source cannot proceed until the target is finished",
  implements: "the source is work that carries out the target",
  supersedes: "the source replaces the target",
  annotates: "the source is a note about the target",
  documents: "the source is a report evidencing the target",
  derived_from: "the source was produced by measuring the target",
  relates_to: "weak association; use a stronger rel if one fits",
};

/** Rels that may appear at most once on a given source. */
export const singularRels = ["supersedes"];

/** What a report entry points at. Large content is a FILE, never inline. */
export const reportEntryTypes = {
  prose: "markdown — the reasoning, the argument, the write-up",
  image: "screenshot, render, diff image",
  code: "a snippet or a script that reproduces something",
  data: "json/csv — measurements in machine-readable form",
  metric: "a single named number, inline (the one exception to files)",
  link: "an external URL",
};

/** Where a resource came from, when it did not originate here. */
export const sourceSystems = {
  local: "filed in this repo",
  asana: "Asana",
  github: "a GitHub issue or PR",
  linear: "Linear",
  figma: "a Figma comment or file",
};

/**
 * Priority as an ORDERED enum: the name is validated, the rank makes it sortable.
 *
 * Neither free text nor a bare number. Free-text priority grows "High",
 * "Medium-High", "High (done)" and "Medium-High — but only after the migration",
 * so nothing can sort or group by it. A bare integer sorts but invites argument
 * about whether something is a 2 or a 3; a named rung is a decision people can
 * share.
 */
export const priorities = {
  critical: { rank: 1, describes: "blocks everything else; drop other work" },
  high: { rank: 2, describes: "next, once current work lands" },
  medium: { rank: 3, describes: "wanted, not urgent" },
  low: { rank: 4, describes: "do it when convenient" },
};

/** Every closed tag axis, so tooling iterates rather than hard-codes. */
export const tagAxes = { area: areas };

export const types = Object.keys(docTypes);
