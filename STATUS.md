# STATUS — Bot Butler

_Last verified: 2026-07-03 · Node v24 · Windows (PowerShell) · 59/59 tests passing · `npm run demo` exits 0 with the pause+resume invariant PASS · `npm run x402-demo` exits 0 with the full 402→pay→200 handshake PASS._

## What works (end-to-end, in mock mode — the default)

| Piece | Where | Verified by |
|---|---|---|
| **Strategist** — `{budget, risk, preference}` (flags or plain English: `propose "I have $500, medium risk, prefer majors"`) → pair pick from measured candles (ATR%, EMA-gap trend score, grid-fit ranking) → grid or DCA-martingale params sized to risk → human-readable proposal with line-by-line reasoning | `src/strategist.js`, `src/grid.js`, `src/regime.js` | demo step 1; `test/grid.test.js`, `test/regime.test.js` |
| **Launch flow with safety rails** — explicit confirmation (interactive y/N, `--confirm` flag; aborts if neither), hard caps re-checked at launch ($1,000/bot, $2,000 total, 3 active bots, majors-only unless alts opted in), everything appended to the action log | `src/launch.js`, `src/index.js`, caps in `src/config.js` | demo step 2; manual runs incl. non-TTY abort |
| **Steward loop** — `node src/index.js tick` (one tick) or `tick --watch --interval <s> [--ticks n]`. Each tick: advance mock market 1 candle → re-detect regime per bot → auto-PAUSE (breakout beyond range + 0.25×ATR buffer, or \|trend score\| ≥ 1.1), auto-RESUME (back inside + calm ≤ 0.6 for 2 consecutive ticks + cooldown), propose resize near range edges / re-center when stranded outside. Every decision logged with its reason | `src/steward.js` (pure `decide()` is unit-tested) | demo step 3; `test/gridsim.test.js` decide() suite |
| **Daily digest** — `node src/index.js digest` → `out/digest-<date>.md`: market snapshot, bot table with simulated P&L (realized / unrealized / fees), every action since the last digest with reasons, regime commentary via the LLM adapter | `src/digest.js`, `src/adapters/llm.js` | demo step 4; standalone runs |
| **Demo scenario** — `npm run demo`: propose → confirm → launch → 46 scripted ticks (range → breakout → reversion → range) → digest. Deterministic (seed 7 + scripted regimes) and **self-verifying**: exits non-zero unless ≥1 auto-pause AND ≥1 auto-resume actually fired | `src/demo.js` | run it; probed across seeds 1–24 with `scripts/probe-seeds.mjs` (23/24 pass; seed 6 correctly stays paused while its trend score hovers ≈ −0.9) |
| **Manual overrides** — `pause/resume/stop <botId>`, `resize <botId>` (applies the steward's re-center suggestion), `reset` — all confirmation-gated | `src/index.js` | manual runs |
| **State** — one JSON file `state/butler-state.json` (simulated market incl. RNG state, proposals, bots + fill sims, append-only action log). Atomic-ish write (tmp + rename); separate CLI processes continue the same world | `src/state.js` | tick from separate processes continues t=46 → 47 |

## What's mocked (and how honestly)

- **Market data** (`src/mock/market.js`): seeded random-walk hourly candles for BTC/ETH/SOL/XRP (+DOGE as the non-major), regime engine (range ⇄ trend, mean-reversion anchors), fully persisted in state — deterministic per seed. The demo overrides it with a scripted regime sequence; normal `tick` uses random regime changes.
- **Fills / P&L** (`src/mock/gridsim.js`): a real discrete grid engine — level crossings fill orders, opposite order placed one level over, average-cost inventory accounting, 0.1%/side fees; unrealized = mark-to-market. DCA-martingale cycles (base + scaled safety orders + take-profit) likewise. This is simulation, not backtest-grade truth, but the math is unit-tested and directionally honest.
- **Bot lifecycle**: pause/resume/stop/resize mutate the local bot record; a paused bot's orders stop filling and its inventory keeps marking to market (resume rebases to the current price so there are no phantom back-fills).
- **LLM commentary** (`src/adapters/llm.js`): canned, context-aware templates (breakout-and-recovery vs trending vs quiet-range), fed real digest numbers. `LLM_MODE=real` throws a documented stub; the digest catches it and falls back visibly.
- **Not simulated**: order-book depth, partial fills, slippage, funding, per-pair tick/lot size rules, exchange downtime.

## x402 payment layer (pay-per-call on `POST /api/propose`)

The OKX.AI listing meters one route — `POST /api/propose` at **8 USDT/call** — via the
[x402](https://x402.org) HTTP 402 handshake. Everything downstream of a paid proposal
(`/api/launch`, `/api/tick`, `/api/status`, `/api/digest`), the dashboard UI and
`/api/health` stay free. Code: `src/x402/gate.js` (gate + PaymentRequirements) and
`src/adapters/facilitator.js` (verify/settle seam, same adapter pattern as `okx.js`/`llm.js`).

**Envs**

| Env | Values | Meaning |
|---|---|---|
| `X402_MODE` | `off` (default) \| `mock` \| `real` | `off`: gate is a no-op, every route behaves exactly as before x402 existed. `mock`: in-process verify/settle (demo-ready). `real`: OKX x402 facilitator over HTTPS. |
| `X402_PAY_TO` | 0x-address | Receiving wallet in the challenge (default placeholder `0xREPLACE_OWNER_WALLET`). |
| `OKX_X402_API_KEY` / `OKX_X402_SECRET` / `OKX_X402_PASSPHRASE` | strings | Facilitator creds, **required in real mode** — missing creds fail fast at gate creation, never wave callers through. |

**Flow** (mock or real mode)

1. `POST /api/propose` without a payment header → **402** with header
   `PAYMENT-REQUIRED: base64(JSON challenge)` — the **full challenge object**
   `{x402Version:1, resource:"/api/propose", accepts:[PaymentRequirements]}` (OKX's x402
   validator decodes the header and reads `accepts[]` from it; a bare PaymentRequirements
   object fails as "accepts is empty"). Each `accepts[]` entry is `{x402Version:1,
   scheme:"exact", network:"eip155:196" (X Layer), maxAmountRequired:"8000000" (8 USDT × 10⁶,
   6 decimals), asset: USDT 0x779d…3736, payTo, resource:"/api/propose", maxTimeoutSeconds:60}`.
   The JSON body echoes the same challenge: `{ok:false, x402Version, resource, accepts:[...]}`
   plus a retry hint (and an `error` field on rejections).
2. Client signs the chosen `accepts[]` entry and retries with
   `PAYMENT-SIGNATURE: base64(JSON PaymentPayload)` (v2 — what `onchainos payment pay` replays
   with; checked first) or the legacy `X-PAYMENT: base64(JSON PaymentPayload)` (still accepted
   as fallback; same base64-JSON decode) → facilitator `verify()` then
   `settle()`; success → the normal proposal response **plus**
   `PAYMENT-RESPONSE: base64(JSON receipt)` (`{success, transaction, network, payer, status}`);
   verify/settle failure → 402 again with an `error` field.
3. Payment settles **before** the handler runs (an unpaid call does zero work); if the handler
   then rejects the input (e.g. missing budget), the error response still carries the receipt.

**Verify it**: `npm run x402-demo` — spawns the server with `X402_MODE=mock` on port 4177 and
walks the whole handshake (free health check → 402 challenge → decode `accepts[0]` → mock pay
via `PAYMENT-SIGNATURE` → 200 + receipt + proposal → legacy `X-PAYMENT` still accepted →
garbage-payment rejection), self-verifying like `npm run demo`.
Unit coverage in `test/x402.test.js` (off-mode passthrough, challenge shape, amount math,
mock round trip, determinism, bad payments, real-mode fail-fast).

**Confirmed vs assumed**

- ✅ Confirmed/spec-driven: the 402 handshake shape, `exact` scheme fields, X Layer chain id
  `eip155:196`, USDT contract `0x779ded0c9e1022225f8e0630b35a9b54be713736`, 6-decimal amount math.
- ⚠️ **ASSUMED, pending confirmation** (commented in `src/adapters/facilitator.js`): real-mode
  endpoints `POST https://web3.okx.com/api/v6/pay/x402/verify` and `/settle` with body
  `{paymentPayload, paymentRequirements}`, signed with OKX v5-style headers
  (`OK-ACCESS-KEY`, `OK-ACCESS-SIGN` = base64(HMAC-SHA256(timestamp+method+requestPath+body,
  secret)), `OK-ACCESS-TIMESTAMP`, `OK-ACCESS-PASSPHRASE`). Alternative once npm deps are
  allowed: the official SDKs — `@okxweb3/x402-core` / `x402-express` / `x402-evm` — which
  handle signing and payload construction outright.
- Mock `verify()` checks shape/scheme/network/amount only — it does **not** validate the
  EIP-3009 signature; that is the real facilitator's job.

## Real-mode wiring steps (when OKX API keys exist)

All exchange calls already route through **one seam**: `src/adapters/okx.js`. Running anything with `OKX_MODE=real` today throws `OKX_REAL_NOT_WIRED` errors that print the exact expected command per method. To wire:

1. **Keys**: create OKX **demo-trading** keys first; set `OKX_API_KEY`, `OKX_API_SECRET`, `OKX_API_PASSPHRASE` (+ `OKX_SIMULATED=1` for demo trading).
2. **Install the OKX skills**: `okx/agent-skills` market-data + bots skills (`okx-trade-cli`). Verify each command's exact flags against the installed skill version — the stubs record the intended call, e.g.:
   - `fetchCandles` → `okx-trade-cli market candles --inst-id BTC-USDT --bar 1H --limit 96`
   - `fetchTicker` → `okx-trade-cli market ticker --inst-id <instId>`
   - `createBot` (grid) → `okx-trade-cli bots create-grid --inst-id … --min-price … --max-price … --grid-num … --investment …` (→ `POST /api/v5/tradingBot/grid/order-algo`)
   - `pauseBot` → `bots stop --stop-type keep_position` (the public grid API has **no native pause**; pause = stop-keeping-position, resume = re-create over the kept position — or use the bots skill's pause if it exposes one)
   - `stopBot` → `bots stop --stop-type sell_base`
   - `getBot` → `bots status --algo-id <id>` (grid/float/total profit)
   - `amendBotRange` → stop + re-create (no in-place range edit in the public API)
   - DCA-martingale: confirm the bots skill exposes it; if not, grid-only at launch.
3. **Implement**: replace each stub body with `execFile('okx-trade-cli', [...])` + JSON parse, mapping to the same return shapes the mock produces (`{ botId, status }`, candle arrays `{ts,o,h,l,c,v}`, P&L snapshot). Store the exchange `algoId` on the bot record. `advanceMarket` stays a no-op in real mode — the steward code is already mode-agnostic.
4. **Cross-check the strategist** against OKX's AI-recommended grid params endpoint (the bots skill exposes it) and tighten `RISK_PROFILES` if they disagree badly.
5. **Schedule** the loop: `node src/index.js tick` from cron/Task Scheduler (e.g. every 15 min), `digest` daily. State already survives process restarts.
6. **LLM**: set `ANTHROPIC_API_KEY`, `LLM_MODE=real`, and implement the documented `POST /v1/messages` call in `src/adapters/llm.js` (prompt sketch is in the stub).

## How to run

```powershell
npm run demo                                   # the whole story in ~5 seconds, deterministic
npm run x402-demo                              # pay-per-call handshake: 402 -> mock pay -> 200 + receipt
npm test                                       # 59 tests: regime math, grid/DCA math, fill sim, steward policy, x402 gate
node src/index.js propose "I have $500, medium risk, prefer majors"
node src/index.js launch prop-1 --confirm
node src/index.js tick --watch --interval 5    # stewardship loop (Ctrl+C to stop; state saved every tick)
node src/index.js digest                       # out/digest-<date>.md
node src/index.js status                       # bots, market, recent actions
node scripts/probe-seeds.mjs 1 24              # dev tool: demo-scenario robustness across seeds
$env:OKX_MODE='real'; node src/index.js status # see the documented not-wired stubs
node src/index.js reset --confirm              # fresh world
```

## Known limitations / notes

- Digest filename is per-date (`digest-YYYY-MM-DD.md`) and overwrites on re-run within the same day.
- The steward's caution is asymmetric by design: it will stay paused while the trend score hovers just above the calm threshold (seen on probe seed 6) — it never resumes into ambiguity.
- Demo regime script runs 46 ticks (≈2 simulated days) so the post-breakout cool-off is long enough for an honest resume; the invariant is asserted, not assumed.
- One steward tick = one simulated hourly candle in mock mode; in real mode a tick is just "evaluate now", so cron cadence is free to differ.
