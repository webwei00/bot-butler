// Central configuration: paths, safety caps, risk profiles, regime/steward thresholds.
// Everything tunable lives here so the safety rails are auditable in one place.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const STATE_DIR = path.join(ROOT, 'state');
export const STATE_PATH = path.join(STATE_DIR, 'butler-state.json');
export const OUT_DIR = path.join(ROOT, 'out');

/** Adapter mode: 'mock' (default, fully simulated) or 'real' (documented stubs until API keys exist). */
export function okxMode() {
  const m = (process.env.OKX_MODE || 'mock').toLowerCase();
  if (m !== 'mock' && m !== 'real') {
    throw new Error(`OKX_MODE must be 'mock' or 'real' (got '${m}')`);
  }
  return m;
}

// ---------------------------------------------------------------------------
// SAFETY RAILS (hard caps — enforced at proposal time AND again at launch)
// ---------------------------------------------------------------------------
export const CAPS = {
  maxAllocationPerBot: 1000, // USDT — no single bot may exceed this
  maxTotalAllocation: 2000,  // USDT — sum across all non-stopped bots
  maxActiveBots: 3,
  minBudget: 50,             // below this, grid spacing math stops making sense
};

/** Majors-only is the default universe. Alts require an explicit opt-in preference. */
export const MAJORS = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'XRP-USDT'];

/** Conservative spot taker fee per side used for simulated fills and spacing floors. */
export const FEE_RATE = 0.001; // 0.1%

/** A grid step must clear round-trip fees (2 x 0.1%) with margin, or we widen the grid. */
export const MIN_SPACING_PCT = 0.45; // % of price per grid step

// ---------------------------------------------------------------------------
// RISK PROFILES — how a stated risk appetite maps to bot parameters
//   atrMult:   grid half-range in hourly-ATR(14) units. Hourly ATR ~= daily
//              ATR / 5, so 6-12 hourly ATRs ~= 1.2-2.4 daily ATRs of room.
//              Lower risk = wider range (survives more movement before the
//              price escapes the grid).
//   gridCount: number of grid intervals (higher risk = tighter, busier grid)
//   budgetUse: fraction of the stated budget actually deployed (rest is buffer)
// ---------------------------------------------------------------------------
export const RISK_PROFILES = {
  low: {
    atrMult: 12,
    gridCount: 8,
    budgetUse: 0.6,
    pairWhitelist: ['BTC-USDT', 'ETH-USDT'], // low risk sticks to the two most liquid majors
    dca: { safetyOrders: 3, deviationAtrMult: 4.5, volumeScale: 1.3, takeProfitPct: 1.0 },
  },
  medium: {
    atrMult: 9,
    gridCount: 12,
    budgetUse: 0.8,
    pairWhitelist: null, // any major
    dca: { safetyOrders: 5, deviationAtrMult: 3.6, volumeScale: 1.5, takeProfitPct: 1.5 },
  },
  high: {
    atrMult: 6,
    gridCount: 20,
    budgetUse: 1.0,
    pairWhitelist: null,
    dca: { safetyOrders: 7, deviationAtrMult: 3.0, volumeScale: 1.8, takeProfitPct: 2.0 },
  },
};

// ---------------------------------------------------------------------------
// REGIME DETECTION — trend vs range classification on hourly candles
//   trendScore = (EMA(fast) - EMA(slow)) / ATR   (dimensionless)
// The 5/13 pair reacts fast AND recovers fast after a trend ends — slower
// pairs (8/21) leave the score pinned high for dozens of candles after a big
// move, stranding paused bots. Hysteresis: pause when |score| >=
// trendThreshold, only resume once |score| <= calmThreshold.
// ---------------------------------------------------------------------------
export const REGIME = {
  emaFast: 5,
  emaSlow: 13,
  atrPeriod: 24, // longer ATR window: right after a trend ends, a short ATR collapses
                 // faster than the EMA gap decays, pinning |score| high and stranding
                 // paused bots. 24 candles keeps the denominator honest through the cool-off.
  trendThreshold: 1.1,
  calmThreshold: 0.6,
};

// ---------------------------------------------------------------------------
// STEWARD POLICY — when the butler intervenes
// ---------------------------------------------------------------------------
export const STEWARD = {
  breakoutBufferAtr: 0.25,            // price must clear the range by this many ATRs to count as a breakout
  edgeZonePct: 0.15,                  // within 15% of range width from an edge => "drifting near edge"
  resizeProposalCooldownTicks: 6,     // don't nag about resizing every tick
  resumeCooldownTicks: 2,             // never resume within N ticks of a pause
  resumeCalmStreak: 2,                // require N consecutive calm+inside ticks before resuming
                                      // (a V-reversal passes through "calm" for a single tick — don't fall for it)
  proposeRecenterAfterOutsideTicks: 8 // paused & still outside the range this long => propose re-centering
};
