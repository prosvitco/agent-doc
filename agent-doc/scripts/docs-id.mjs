// scripts/docs-id.mjs
//
// Mints, records and resolves document IDs. The lowest layer: this file owns the
// paths, so `docs-lib` imports it rather than the other way round.
//
// WHY NOT A COUNTER
//
// The old id was `max(existing) + 1`, scanned from the directory. That is right
// about one thing — a scan cannot be wrong the way a number quoted in prose can
// — and wrong about the thing that actually matters: THE DIRECTORY IS PER BRANCH.
//
// Two branches each file a task, both scan, both get 11, and the damage is not
// the `11.json` conflict — git catches that one loudly. It is `links.jsonl` and
// `tags.jsonl`, which are append-only JSONL precisely so they MERGE CLEANLY, and
// they do: the loser's rows arrive intact and silently re-attach to the winner.
// Every check still passes. Both endpoints exist, the rel is valid, the area tag
// is valid, and one document now carries another's history.
//
// So the id must be minted without a coordination point. Type prefix, then six
// characters of entropy:
//
//     task-k3f9x2      rule-8mq04p      note-w2c7ht
//
// The type is in the id even though it is also a column. That is a deliberate
// second copy of one fact, and the only one in this model — `load()` checks the
// two agree, which makes it a checked redundancy rather than a drifting one. It
// buys a readable id, and it namespaces the entropy per type.
//
// SIX CHARACTERS, AND WHY THAT IS ENOUGH
//
// 32^6 ≈ 1.07e9 per type. By the birthday bound, n documents of one type collide
// with probability ≈ n²/2^31: ~0.05% at 1,000, ~4.6% at 10,000. That sounds thin
// until you notice WHICH collisions can hurt:
//
//   Locally     `mintId` retries — the loop below cannot return a taken id, so a
//               local collision costs one iteration and nothing else.
//   Cross-branch The only unguarded case, and it is bounded by documents IN
//               FLIGHT, not by the corpus: a few dozen unmerged docs, so ~1e-6.
//   Migration   Derived, not rolled, so a collision is permanent — `deriveId`
//               handles it by re-hashing, deterministically. See `docs-migrate`.
//
// `ID_LEN` is one constant. Raise it if a repo ever gets big enough to care;
// nothing else needs to change, because ids are opaque everywhere else.

import { existsSync, appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createHash, randomInt } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DOCS = join(ROOT, "docs");
export const DATA = join(DOCS, "data");

/** Crockford's base32: no `i`, `l`, `o` or `u`, so nothing reads as something else. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export const ID_LEN = 6;

/**
 * The shape every id must have: `<type>-<suffix>`.
 *
 * The suffix is deliberately looser than what `mintId` produces. One document —
 * the seeded skill — carries a hand-picked id (`skill-docs-model`), because it
 * is the entry point every install quotes in its AGENTS.md before a database
 * exists to look anything up in. That is the single exception to "the id is
 * assigned, never typed", and a regex that forbade it would only push the
 * exception somewhere less visible.
 */
export const ID_RE = /^[a-z]+-[0-9a-z][0-9a-z-]*$/;

// ---------------------------------------------------------------------------
// The ledger: every id ever minted, including the dead ones
// ---------------------------------------------------------------------------
//
// `docs/data/ids.jsonl`, append-only, NEVER pruned — not by `docs:rm`, not by
// anything. Three jobs, and the third is the one that pays for the file:
//
//   Ids are not reused. `docs:rm` has always CLAIMED this; with a live-directory
//   scan it was false, because deleting the highest number handed it straight
//   back to the next document. A reference in an old commit message, an old
//   branch or a prose paragraph now keeps meaning what it meant.
//
//   Uniqueness survives deletion. `mintId` asks the ledger, not the directory.
//
//   A CROSS-BRANCH COLLISION BECOMES LOUD. This is the failure the whole change
//   exists to prevent, and entropy makes it unlikely rather than impossible. Two
//   branches minting the same id append the same line twice; the merge keeps
//   both, and `load()` fails on the duplicate. The one file that used to hide
//   the collision is now the file that reports it.

const LEDGER = join(DATA, "ids.jsonl");

/** Every id in the ledger, in file order — duplicates INCLUDED, for the check. */
export function ledger() {
  if (!existsSync(LEDGER)) return [];
  return readFileSync(LEDGER, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/** Record a mint. Called once per id, by whatever created the document. */
export function recordId(id, at) {
  mkdirSync(DATA, { recursive: true });
  appendFileSync(LEDGER, `${JSON.stringify({ id, at: at ?? today() })}\n`);
}

export const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Legacy ids: the one-way map left behind by `docs:migrate`
// ---------------------------------------------------------------------------
//
// `docs/data/legacy-ids.jsonl` — `{"old":"11","new":"task-k3f9x2"}`.
//
// Not a field on the document. A `legacy_id` in the JSON would be a second
// identifier living on the resource, and the model already refuses that shape
// for `summary` (docs-lib) for the same reason. Here it is a lookup table for a
// one-time event, in the same append-only JSONL as the other pivots.
//
// It exists because ONE class of reference cannot be rewritten: prose. A file
// saying "supersedes the approach in task 11" is English, and a rewriter cannot
// tell that from "11 tests failed". Those numbers outlive the migration, so
// `resolveId` answers for them.
//
// And it degrades to nothing. Delete the file once nothing quotes old numbers
// and every command still works — the same test the prose summary has to pass.

const LEGACY = join(DATA, "legacy-ids.jsonl");

export function legacyMap() {
  const map = new Map();
  if (!existsSync(LEGACY)) return map;
  for (const line of readFileSync(LEGACY, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const { old, new: now } = JSON.parse(line);
      if (old && now) map.set(String(old), now);
    } catch { /* reported by load(), not here */ }
  }
  return map;
}

export function recordLegacy(pairs) {
  mkdirSync(DATA, { recursive: true });
  appendFileSync(LEGACY, pairs.map(([old, now]) => `${JSON.stringify({ old, new: now })}\n`).join(""));
}

// ---------------------------------------------------------------------------
// Minting
// ---------------------------------------------------------------------------

/** Every id that must never be handed out again: live, dead, or migrated-from. */
export function takenIds() {
  const taken = new Set();
  const dir = join(DATA, "docs");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) if (f.endsWith(".json")) taken.add(f.replace(/\.json$/, ""));
  }
  for (const row of ledger()) taken.add(row.id);
  for (const now of legacyMap().values()) taken.add(now);
  return taken;
}

/**
 * A free id for `type`.
 *
 * The set it checks against is the ledger, not the directory — see above. The
 * caller must still write the file with the `wx` flag: this returns an id that
 * was free when it was asked, and two `docs:new` processes racing (an agent
 * running commands in parallel is the ordinary case here, not the exotic one)
 * can both be told the same thing. Exclusive create is what actually decides it;
 * this loop just makes losing vanishingly rare. See `claimId`.
 */
export function mintId(type, taken = takenIds()) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    let suffix = "";
    for (let i = 0; i < ID_LEN; i++) suffix += ALPHABET[randomInt(ALPHABET.length)];
    const id = `${type}-${suffix}`;
    if (!taken.has(id)) return id;
  }
  throw new Error(`could not mint a free ${type} id in 1000 attempts — raise ID_LEN in docs-id.mjs`);
}

/**
 * Mint and CLAIM in one step: the file is created empty-exclusive, so the id is
 * unforgeably ours before anything else runs. Returns `{ id, path }`; the caller
 * overwrites the placeholder with the real body.
 *
 * A crash between claim and write leaves a zero-byte `.json`, which `load()`
 * reports as invalid JSON. That is the right failure: visible, named, and one
 * `rm` away — as opposed to two documents quietly sharing an id.
 */
export function claimId(type) {
  const taken = takenIds();
  const dir = join(DATA, "docs");
  mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = mintId(type, taken);
    const path = join(dir, `${id}.json`);
    try {
      // `wx` — fails if it exists. The only check that survives a race.
      appendFileSync(path, "", { flag: "wx" });
      return { id, path };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      taken.add(id);
    }
  }
  throw new Error("could not claim a free id — is docs/data/docs writable?");
}

/**
 * The id a migration gives an existing document. DERIVED, never rolled.
 *
 * Two branches migrating the same database independently must produce the SAME
 * ids, or the merge is unsalvageable — worse than the collision this whole
 * change is fixing. So the id is a hash of what the document already is, and the
 * migration becomes idempotent: same input, byte-identical output, every time.
 *
 * `taken` resolves the one case randomness handles for free. Re-hashing with an
 * incrementing salt keeps it deterministic, so long as the caller feeds ids in a
 * fixed order — `docs-migrate` sorts before it maps.
 */
export function deriveId(type, oldId, title, taken = new Set()) {
  for (let salt = 0; salt < 1000; salt++) {
    const seed = `${type}\0${oldId}\0${title}${salt ? `\0${salt}` : ""}`;
    const digest = createHash("sha256").update(seed).digest();
    let suffix = "";
    for (let i = 0; i < ID_LEN; i++) suffix += ALPHABET[digest[i] % ALPHABET.length];
    const id = `${type}-${suffix}`;
    if (!taken.has(id)) return id;
  }
  throw new Error(`could not derive a free id for ${oldId}`);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * What the user typed → a real id.
 *
 * Four ways in, tried in order, because an opaque id is only usable if you never
 * have to type all of it:
 *
 *   exact       `task-k3f9x2`
 *   prefix      `task-k3f` or just `k3f` — git's short-sha bargain. Ambiguity is
 *               reported with the candidates named, never resolved by guessing.
 *   legacy      `11`, from a prose paragraph written before the migration.
 *
 * Returns `{ id }`, `{ ambiguous: [...] }`, `{ moved: from }` alongside the id,
 * or `{}` for nothing found — a shape rather than an exception, because each
 * caller prints a different next command.
 */
export function resolveId(raw, byId, legacy = legacyMap()) {
  if (!raw || raw === true) return {};
  const want = String(raw).trim().toLowerCase();

  if (byId.has(want)) return { id: want };

  const ids = [...byId.keys()];
  const prefix = ids.filter((id) => id.startsWith(want) || id.split("-").slice(1).join("-").startsWith(want));
  if (prefix.length === 1) return { id: prefix[0] };
  if (prefix.length > 1) return { ambiguous: prefix.sort() };

  const moved = legacy.get(want);
  if (moved && byId.has(moved)) return { id: moved, moved: want };

  return {};
}

/** The shared failure message, so every command says the same thing. */
export function resolveOrExit(raw, byId, legacy = legacyMap()) {
  const r = resolveId(raw, byId, legacy);
  if (r.id) {
    if (r.moved) console.error(`  note: ${r.moved} is now ${r.id} (docs/data/legacy-ids.jsonl)`);
    return r.id;
  }
  if (r.ambiguous) {
    console.error(`'${raw}' is ambiguous — ${r.ambiguous.length} documents start with it:\n`);
    for (const id of r.ambiguous) console.error(`  ${id}`);
    console.error(`\nType more of it.`);
    process.exit(1);
  }
  console.error(`no such document: ${raw}

Ids look like \`task-k3f9x2\`. Any unambiguous prefix works — \`k3f\` is usually
enough. A bare number from before the migration resolves too, if the map is
still in docs/data/legacy-ids.jsonl.

  npm run docs:show`);
  process.exit(1);
}
