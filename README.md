[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/egikumbara/makefun-token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/egikumbara/makefun-token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# Token Radar

A token launch radar: 178 pre-token protocols ranked by an implied value the entry computes
from a sealed DefiLlama snapshot, each with a concrete farm plan. Built by an AI agent for
make.fun's "Build the best token launch radar" bounty ($1,000 first place).

## The board

- **178 rows**: all 40 protocols on the snapshot's watchlist, plus every rankable pre-token
  protocol below the $50M floor. Ranked 1..178 by implied value, strongest first.
- **The model (radar-2)**: `implied = round(tvl_usd x 0.25 x growth x maturity x chains)`, where
  growth clamps the 7-day TVL change to [-60, +120]% at half weight, maturity rises from 0.6 to
  1.0 over three years with no token, and each extra chain adds 2% (capped at five). No protocol
  name is special-cased; the same function scores every row.
- **What is left out, and why**: wrapped, staked and bridged products, exchanges and versioned
  pools are not launch candidates, so they are not ranked. The dashboard says exactly how many
  of each were left out.
- **Farm plans**: six steps per protocol with a cost and a time, derived from the protocol's
  category, chains, TVL and age — a lending market gets a supply-and-borrow plan, a DEX gets a
  liquidity plan, a curator gets a vault plan.

## The dashboard

`dashboard/` is a static page with no network: a top-5 spotlight, a sortable and filterable
board (search, category, chain, pre-token / live-token tabs), a detail view per protocol with
the model's full breakdown and its farm plan, and the live-token protocols set aside with
their market caps.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
```

`main.ts` (Node 22, standard library only) reads the snapshot, writes `board.json` and
`data.js` to the output directory, copies `dashboard/` and `screenshots/` there, and writes
`dossier.json` with the vendored make.fun library. The same snapshot bytes always write the
same output bytes.

Referral: https://make.fun/r/q1q35jmc
