# Bot Butler

**A grid/DCA strategist that manages, not just creates.** User states risk appetite and budget in plain English; the agent picks pairs, configures a grid or DCA-martingale bot, then keeps stewarding it — pausing in chop, resizing ranges, sending a daily "here's what your bot did" digest.

## Target: Best Product (+ Finance Copilot side category)

Most hackathon bots are set-and-forget. The ongoing stewardship + reliability story is the Best Product angle: product quality, reliability, long-term potential.

## Revenue model

- Setup fee per strategy ($5–10)
- Monthly stewardship subscription (the real business)

## How it works

```
"I have $500, medium risk, prefer majors"
        │
        ▼
┌─ Strategist ────────────┐   market-data skill: candles,
│ pair selection,         │   volatility, 70+ indicators
│ grid range / DCA params │   bots skill: AI-recommended params
└──────────┬──────────────┘
           ▼
┌─ Launch ────────────────┐   bots skill: create grid /
│ user confirms → deploy  │   DCA-martingale bot
└──────────┬──────────────┘
           ▼
┌─ Steward (cron) ────────┐
│ • regime check (trend   │
│   vs range) → pause/    │
│   resume                │
│ • range drift → resize  │
│ • daily digest → user   │
└─────────────────────────┘
```

## Run it (mock mode — works today, no API keys needed)

```
npm run demo                              # 90-second demo backbone: propose -> confirm ->
                                          # launch -> breakout (auto-pause) -> reversion
                                          # (auto-resume) -> daily digest. Deterministic.
npm test                                  # 41 unit tests (regime math, grid math, fill sim, steward policy)

node src/index.js propose "I have $500, medium risk, prefer majors"
node src/index.js launch prop-1           # asks y/N; --confirm to skip
node src/index.js tick --watch --interval 5   # the stewardship loop
node src/index.js digest                  # writes out/digest-<date>.md
node src/index.js status | help
```

See **STATUS.md** for what's real vs mocked and the exact real-mode wiring steps.

## Stack

- Plain Node.js ESM JavaScript, zero dependencies (node:test for tests)
- ONE exchange seam: `src/adapters/okx.js` — `OKX_MODE=mock` (default, full simulation)
  or `OKX_MODE=real` (documented stubs for `okx/agent-skills` bots + market-data skills)
- Steward loop runnable per-tick (`tick`) or on an interval (`tick --watch`); cron-able as-is
- LLM adapter (`src/adapters/llm.js`) for digest commentary — canned templates in mock,
  documented Claude API call for real

## Safety rails

- Explicit user confirmation before any bot create/modify/stop
- Hard caps: max allocation per bot, majors-only default
- Every action logged and reported in the digest — no silent changes

## Build plan

- [ ] Phase 1 — Rails: agent-skills bots endpoints working end-to-end on a test account (create/pause/stop a tiny grid bot)
      — **blocked on API keys.** The full rails exist in mock mode behind `src/adapters/okx.js`; every real
      endpoint is a marked stub documenting the exact `okx-trade-cli` command to wire (see STATUS.md).
- [x] Phase 2 — Strategist: risk-profile → pair + parameter selection (own volatility/ATR + trend filter over
      mock market data; cross-check against OKX AI-recommended params once keys exist)
- [x] Phase 3 — Steward loop: regime detection, pause/resume + resize logic, action log
- [x] Phase 4 — Digest: daily P&L + actions-taken summary (`out/digest-<date>.md`)
- [ ] Phase 5 — Marketplace: ASP listing, pricing (setup + subscription)
- [ ] Phase 6 — Demo: 90s video — the scripted backbone is done (`npm run demo`, deterministic,
      shows pause + resume interventions); recording still to do
- [ ] Submit Google form (after listing, before Jul 17 00:00 UTC)
- [ ] Post demo on X with #okxai

## Demo script (≤90s)

1. (0–15s) "Grid bots die when the market changes. Nobody watches them. This agent does."
2. (15–50s) "$500, medium risk" → agent proposes → confirm → bot live on OKX
3. (50–90s) Show a digest where the butler paused the bot during a breakout and resumed after. "Set, but never forget."
