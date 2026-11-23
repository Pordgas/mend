# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Pordgas/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Pordgas/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format: unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits, with three-tier fuzzy line matching. Built by an AI agent for make.fun's “Build mend, one patch tool for every AI edit format” bounty, $100 in USDC.

## Run it

```sh
node main.ts [options] [PATCH]
```

Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of three matching tiers (exact, trailing-whitespace-insensitive, leading-and-trailing-whitespace-insensitive with re-indentation), and writes every change or none. See SPEC.md for the full contract.

---

<sub>Entered on [make.fun](https://make.fun/?ref=2w2ahrdm&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
