# mend — build notes

Entry for make.fun bounty "Build mend, one patch tool for every AI edit format"
(hidden-spec-cli-01-run-20261122). Build only — no repo, no bundle, no submit.

## Files

- `main.ts` — the CLI (Node 22 stdlib only). Started from the kit starter (sections 1–4,
  9, 10: command line, output/exit codes, safe paths, format detection, JSON edits,
  all-or-nothing write) and added: three-tier line matching (section 5), unified diffs
  (section 6), SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), plus
  move (`R old -> new`) output lines.
- `runner.ts`, `check.ts`, `SPEC.md`, `LICENSE` — kept as the kit has them.
- `README.md` — with the three live make.fun badges for this competition.
- `.makefun/owner.json` — `{"wallet": "7EZABYDPFXFSyPGL3hijr9fSrTAKTaCYR2MqcogjbMZH"}`.

## Practice results

`node check.ts ../hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json`

- **100 of 100 passed, practice score 1000** — per group: unified 30/30,
  search_replace 20/20, v4a 20/20, json 15/15, cli 15/15.
- Strict (tier-0-only) comparison, same set with `--strict` forced (the house
  baseline's behaviour): **75 of 100, score 750** — unified 24/30,
  search_replace 11/20, v4a 11/20, json 15/15, cli 14/15. The fuzzy tiers
  (1–2) are worth +25 points on practice, which is the whole game against the
  baseline: a tier-0-only entry ties the house strict applier and wins nothing.
- Determinism: the full practice run twice, byte-identical output.
- Hand-made edge suite (`~/workspace/makefun/mend-edge-check.mjs`, not committed):
  **54 of 54 passed** — ambiguous matches, trailing whitespace, CRLF files and
  CRLF patches, empty files, atomic failure (a failing edit leaves the succeeding
  edit's file untouched on disk), CLI flag errors (`--format=bad`, duplicate
  option, two positionals, unknown option, `--` handling), unsafe paths,
  V4A add/delete/move/anchor/EOF/pure-move cases, JSON insert out of range and
  overlapping `str_replace`, `--check` with a move (prints `R` but writes
  nothing), no-op patches (`ok: 0 files`), move-then-edit-the-new-file in one
  patch, bare unified sections, rename-only moves, `new file mode` creations,
  deletion hunks not read, trailing blank lines stripped from hunks and V4A
  sections.

## How the matching tiers work

- Tier 0: lines equal. Tier 1: equal after removing trailing spaces/tabs.
  Tier 2: equal after removing leading and trailing spaces/tabs. The first
  tier with at least one occurrence wins; `--strict` tries tier 0 only.
- Unified hunks take the occurrence nearest to `A - 1 + d` (d = line-count drift
  of the section's earlier hunks), ties go to the earlier one. Empty-O hunks
  insert after the first `A + d` lines (clamped to the file).
- SEARCH/REPLACE takes the tier's single occurrence, else `ambiguous`.
- V4A chunks use a cursor: an anchor is matched first (first line at/after the
  cursor at the first tier with one), then the chunk takes the first occurrence
  of O at/after the cursor; an `*** End of File` chunk only takes an occurrence
  ending at the file's last line; empty O inserts at the cursor (or at the end
  for an EOF chunk).
- Context lines are written as the file's own matched line, never the patch's.
  At tier 2, other lines of N are re-indented: F = leading spaces/tabs of the
  file's first matched line, P = those of O's first line; a non-blank N line
  starting with P has P replaced by F (an empty P prepends F).
- Final line break: a changed file keeps its own break and final-break state,
  except a unified hunk whose matched lines run to the end of the file (or an
  empty-O insertion at the end) sets the final break from its `\` line
  (no break when a `\` follows the hunk's last context or `+` line). Created
  files use LF and end with a break unless a `\` follows their last `+` line.
  JSON `create` writes `file_text` byte for byte.

## Sizes

Total repo 58,128 bytes; largest file `main.ts` 31,278 bytes. Caps are
1 MiB per file and 4 MiB per tree — well inside.

## Deliberately left out / known weak spots

These are judgement calls on SPEC sentences the practice set does not show;
the sealed pool tests such sentences, so these are the riskiest readings:

- A whitespace-only line in the middle of a V4A Add section is a parse error
  (SPEC: Add lines start with `+` or are empty). It could arguably be read as
  an empty file line.
- A `*** End of File` line with no open chunk is a parse error; no empty
  EOF chunk is created.
- A body line after `*** End of File` (before the next `@@`) is a parse error
  (only the first chunk may start at a body line); blank lines there are also
  rejected rather than ignored.
- A `--- ` line in a section header not followed by `+++ ` is
  `error: parse <the line after it>`; if the patch ends at that `--- ` line,
  the reported line is patch-lines + 1 (inferred, not stated).
- A `diff --git` line must match `diff --git a/<X> b/<Y>` with no spaces in the
  paths; quoted paths are a parse error.
- Creating a file where a directory already exists (or under a path that is a
  file) is not specially handled — same behaviour as the kit starter (an
  uncaught fs error), since SPEC does not define it.
- A V4A section's trailing blank lines are stripped before validation; a
  whitespace-only line in the middle of an Update chunk body is a context line
  (it starts with a space), not a blank line.
