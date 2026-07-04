// The Strategist: turns "{ budget, risk, preference }" into a concrete,
// reasoned bot proposal — pair selection from measured market data
// (volatility/ATR + trend score), grid or DCA parameters sized to risk,
// hard caps applied. Nothing launches from here: proposals await confirmation.

import { CAPS, RISK_PROFILES, REGIME } from './config.js';
import { detectRegime, gridFitScore } from './regime.js';
import { planGridParams, planDcaParams, sizeInvestment } from './grid.js';
import { appendAction } from './state.js';
import { fmtPx, fmtUsd, fmtNum, fmtPct, nowIso, round2 } from './util.js';

const KNOWN_SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];

/**
 * Parse a plain-English-ish ask like "I have $500, medium risk, prefer majors"
 * into { budget, risk, preference }. Flags override anything parsed.
 */
export function parseAsk(text = '') {
  const t = text.toLowerCase();
  const out = {};

  const money = t.match(/\$?\s*([\d,]+(?:\.\d+)?)\s*(k)?\s*(?:usd|usdt|dollars|bucks)?/);
  if (money && (t.includes('$') || /\d/.test(t))) {
    let n = parseFloat(money[1].replace(/,/g, ''));
    if (money[2] === 'k') n *= 1000;
    if (Number.isFinite(n) && n > 0) out.budget = n;
  }

  if (/\b(low|conservative|safe|cautious)\b/.test(t)) out.risk = 'low';
  else if (/\b(high|aggressive|degen|risky)\b/.test(t)) out.risk = 'high';
  else if (/\b(medium|med|moderate|balanced)\b/.test(t)) out.risk = 'medium';

  const prefs = [];
  if (/\b(dca|martingale)\b/.test(t)) prefs.push('dca');
  if (/\bgrid\b/.test(t)) prefs.push('grid');
  if (/\b(alts?|altcoins?)\b/.test(t)) prefs.push('alts-ok');
  for (const sym of KNOWN_SYMBOLS) {
    if (new RegExp(`\\b${sym.toLowerCase()}\\b`).test(t)) prefs.push(sym);
  }
  if (/\bmajors?\b/.test(t) || prefs.length === 0) prefs.unshift('majors');
  out.preference = prefs.join(',');

  return out;
}

/** Interpret the preference string into concrete constraints. */
export function parsePreference(preference = 'majors') {
  const parts = String(preference)
    .toLowerCase()
    .split(/[,\s]+/)
    .filter(Boolean);
  const pref = {
    majorsOnly: !parts.includes('alts-ok') && !parts.includes('alts'),
    botType: parts.includes('dca') ? 'dca' : parts.includes('grid') ? 'grid' : 'auto',
    pinInstId: null,
  };
  for (const sym of KNOWN_SYMBOLS) {
    if (parts.includes(sym.toLowerCase())) {
      pref.pinInstId = `${sym}-USDT`;
      break;
    }
  }
  return pref;
}

/** Measure every candidate pair: regime, ATR%, trend score, grid-fit score. */
export async function analyzeUniverse(okx, { majorsOnly = true } = {}) {
  const instruments = await okx.listInstruments();
  const candidates = instruments.filter((i) => (majorsOnly ? i.major : true));
  const analyzed = [];
  for (const inst of candidates) {
    try {
      const candles = await okx.fetchCandles(inst.instId, { limit: 96 });
      const m = detectRegime(candles);
      analyzed.push({ instId: inst.instId, major: inst.major, ...m, fitScore: gridFitScore(m) });
    } catch {
      // Skip a pair whose data is momentarily unavailable (real mode: one flaky
      // OKX call) rather than failing the whole proposal.
      continue;
    }
  }
  if (analyzed.length === 0) {
    throw new Error('No market data available for any candidate pair — try again shortly.');
  }
  analyzed.sort((a, b) => b.fitScore - a.fitScore);
  return analyzed;
}

/**
 * Build a proposal (and record it in state, awaiting confirmation).
 * input: { budget, risk, preference }
 */
export async function buildProposal(ctx, input) {
  const { state, okx } = ctx;
  const budget = Number(input.budget);
  const risk = (input.risk || 'medium').toLowerCase();
  const preference = input.preference || 'majors';

  // --- validation & safety rails (round 1: at proposal time) ---
  if (!Number.isFinite(budget) || budget < CAPS.minBudget) {
    throw new Error(`Budget must be at least ${fmtUsd(CAPS.minBudget, 0)} (got ${input.budget}).`);
  }
  if (!RISK_PROFILES[risk]) {
    throw new Error(`Risk must be one of: ${Object.keys(RISK_PROFILES).join(', ')} (got '${input.risk}').`);
  }
  const activeBots = state.bots.filter((b) => b.status !== 'stopped');
  if (activeBots.length >= CAPS.maxActiveBots) {
    throw new Error(`Cap reached: max ${CAPS.maxActiveBots} active bots. Stop one before proposing another.`);
  }

  const pref = parsePreference(preference);
  const reasoning = [];

  // --- market analysis ---
  const universe = await analyzeUniverse(okx, { majorsOnly: pref.majorsOnly });
  reasoning.push(
    pref.majorsOnly
      ? `Universe: majors only (default safety rail) — ${universe.map((u) => u.instId.split('-')[0]).join(', ')}.`
      : `Universe: majors + alts (you opted in).`
  );

  // --- candidate selection ---
  let pool = universe;
  const wl = RISK_PROFILES[risk].pairWhitelist;
  if (wl) {
    pool = pool.filter((u) => wl.includes(u.instId));
    reasoning.push(`Low risk restricts pairs to ${wl.join(' / ')} (deepest books, calmest tails).`);
  }
  if (pref.pinInstId) {
    const pinned = universe.find((u) => u.instId === pref.pinInstId);
    if (!pinned) throw new Error(`Preferred pair ${pref.pinInstId} is not in the allowed universe.`);
    pool = [pinned];
    reasoning.push(`You asked for ${pref.pinInstId} specifically — honoring that.`);
  }
  if (!pool.length) throw new Error('No candidate pairs left after applying constraints.');

  const pick = pool[0]; // pool is sorted by grid-fit score
  reasoning.push(
    `Picked ${pick.instId}: best grid-fit score ${fmtNum(pick.fitScore, 2)} ` +
      `(volatility ATR ${fmtNum(pick.atrPct, 2)}%/candle, trend score ${fmtNum(pick.trendScore, 2)} => ${pick.regime}).`
  );
  if (Math.abs(pick.trendScore) > REGIME.calmThreshold && pick.regime === 'range') {
    reasoning.push(
      `Heads-up: the trend score is elevated (${fmtNum(pick.trendScore, 2)}); if it crosses ±${REGIME.trendThreshold} ` +
        `after launch, the steward will pause the bot until the market calms.`
    );
  }

  // --- bot type ---
  let botType = pref.botType;
  if (botType === 'auto') {
    botType = pick.regime === 'range' ? 'grid' : 'dca';
    reasoning.push(
      botType === 'grid'
        ? `Regime is '${pick.regime}' — a grid harvests range-bound oscillation, so grid it is.`
        : `Regime is '${pick.regime}' — a grid would fill one-sided in a trend, so DCA-martingale (accumulate dips, take profit on bounces) fits better.`
    );
  } else {
    reasoning.push(`Bot type ${botType.toUpperCase()} was requested explicitly.`);
  }

  // --- sizing (hard caps, round 1) ---
  const investment = sizeInvestment(budget, risk);
  const prof = RISK_PROFILES[risk];
  reasoning.push(
    `Sizing: ${fmtUsd(budget, 0)} budget x ${Math.round(prof.budgetUse * 100)}% (${risk}-risk deployment) = ` +
      `${fmtUsd(investment, 0)}${budget * prof.budgetUse > CAPS.maxAllocationPerBot ? ` — clipped by the ${fmtUsd(CAPS.maxAllocationPerBot, 0)} per-bot hard cap` : ''}.`
  );
  const committed = activeBots.reduce((s, b) => s + b.investment, 0);
  if (committed + investment > CAPS.maxTotalAllocation) {
    throw new Error(
      `Cap reached: ${fmtUsd(committed, 0)} already committed; adding ${fmtUsd(investment, 0)} would exceed the ` +
        `${fmtUsd(CAPS.maxTotalAllocation, 0)} total-allocation cap.`
    );
  }

  // --- parameters ---
  let params;
  if (botType === 'grid') {
    params = planGridParams({ price: pick.price, atr: pick.atr, risk, investment });
    reasoning.push(
      `Grid range [${fmtPx(params.lower)} … ${fmtPx(params.upper)}] = current price ± ${params.atrMult}xATR ` +
        `(${risk} risk favors ${params.atrMult >= 3 ? 'a wider box that survives bigger swings' : 'a tighter, busier box'}).`
    );
    reasoning.push(
      `${params.gridCount} grids => ${fmtNum(params.spacingPct, 2)}% per step, ~${fmtNum(params.estProfitPerFillPct, 2)}% ` +
        `net per round trip after fees (floor: step must clear round-trip fees, else we widen).`
    );
    reasoning.push(`${fmtUsd(params.perGridQuote)} per grid slot across ${params.gridCount} slots.`);
  } else {
    params = planDcaParams({ price: pick.price, atr: pick.atr, risk, investment });
    reasoning.push(
      `DCA ladder: ${fmtUsd(params.baseOrderQuote)} base + ${params.safetyOrders} safety orders every ` +
        `${fmtNum(params.priceDeviationPct, 2)}% down, volume x${params.volumeScale} — full ladder ${fmtUsd(params.ladderTotal)} stays inside the allocation.`
    );
    reasoning.push(`Take profit ${fmtPct(params.takeProfitPct)} on the averaged position; worst-case averaged drawdown ~${fmtNum(params.maxDrawdownPct, 1)}%.`);
  }

  const proposal = {
    id: `prop-${++state.counters.proposal}`,
    createdAt: nowIso(),
    status: 'proposed',
    input: { budget, risk, preference },
    instId: pick.instId,
    botType,
    investment,
    params,
    metrics: {
      price: pick.price,
      atr: pick.atr,
      atrPct: round2(pick.atrPct),
      trendScore: round2(pick.trendScore),
      regime: pick.regime,
      fitScore: round2(pick.fitScore),
    },
    reasoning,
  };
  state.proposals.push(proposal);
  appendAction(state, {
    type: 'propose',
    proposalId: proposal.id,
    instId: pick.instId,
    reason: `Strategist proposed ${botType.toUpperCase()} on ${pick.instId} for ${fmtUsd(budget, 0)} @ ${risk} risk`,
    details: { investment, params },
  });
  return proposal;
}

/** Human-readable proposal block. */
export function renderProposal(p) {
  const lines = [];
  lines.push(`Proposal ${p.id} — ${p.botType.toUpperCase()} bot on ${p.instId}`);
  lines.push(`  You said: ${fmtUsd(p.input.budget, 0)}, ${p.input.risk} risk, prefer ${p.input.preference}`);
  lines.push(`  Deploys:  ${fmtUsd(p.investment, 0)} (of your ${fmtUsd(p.input.budget, 0)} budget)`);
  if (p.botType === 'grid') {
    lines.push(
      `  Grid:     ${p.params.gridCount} levels across [${fmtPx(p.params.lower)} … ${fmtPx(p.params.upper)}], ` +
        `step ${fmtNum(p.params.spacingPct, 2)}%, ${fmtUsd(p.params.perGridQuote)}/slot`
    );
  } else {
    lines.push(
      `  DCA:      base ${fmtUsd(p.params.baseOrderQuote)}, ${p.params.safetyOrders} safety orders every ` +
        `${fmtNum(p.params.priceDeviationPct, 2)}%, volume x${p.params.volumeScale}, TP ${fmtPct(p.params.takeProfitPct)}`
    );
  }
  lines.push(`  Market:   ${p.instId} @ ${fmtPx(p.metrics.price)}, ATR ${p.metrics.atrPct}%/candle, ` +
    `trend score ${p.metrics.trendScore} (${p.metrics.regime})`);
  lines.push('');
  lines.push('  Why:');
  for (const r of p.reasoning) lines.push(`   • ${r}`);
  lines.push('');
  lines.push('  Stewardship policy you are authorizing at launch:');
  lines.push('   • Auto-PAUSE when price breaks out of the grid range or the trend regime turns strong');
  lines.push('   • Auto-RESUME when the market settles back into a range inside the grid');
  lines.push('   • Range RESIZES are only ever proposed — they always require your explicit confirmation');
  lines.push('   • Every action is logged and reported in the daily digest. No silent changes.');
  return lines.join('\n');
}
