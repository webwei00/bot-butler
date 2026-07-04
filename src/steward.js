// The Steward: the ongoing management loop that makes this a butler rather
// than a set-and-forget bot factory.
//
// Each tick it re-measures the market per bot and decides:
//   • PAUSE   — price broke beyond the grid range (breakout) or the regime
//               turned strongly trending: a grid must not sell into a runaway
//               move / catch falling knives one-sided.
//   • RESUME  — the regime has calmed (hysteresis: calmThreshold) AND price is
//               back inside the grid range. Cooldown prevents flapping.
//   • PROPOSE — resize when price drifts near a range edge, or re-center when
//               a paused bot has been stranded outside its range for a while.
//               Proposals are logged and reported, NEVER auto-applied.
//
// Pause/resume authority is granted by the user at launch (it's the product's
// core promise). Anything that changes bot parameters requires confirmation.

import { REGIME, STEWARD } from './config.js';
import { detectRegime, isCalm } from './regime.js';
import { planGridParams } from './grid.js';
import { appendAction } from './state.js';
import { fmtPx, fmtNum } from './util.js';

/**
 * Pure decision function (unit-testable): given a bot record and current
 * market metrics, return the steward's decision.
 *
 * bot:  { status, params: {lower, upper}, pausedAtTick, outsideSinceTick,
 *         lastResizeProposalTick, calmStreak }
 *       (calmStreak = consecutive calm-and-inside ticks INCLUDING this one,
 *        maintained by runTick before calling decide)
 * m:    { price, atr, trendScore, regime }
 * tick: current market tick
 *
 * Returns { action: 'none'|'pause'|'resume'|'propose_resize'|'propose_recenter',
 *           reason, snapshot }.
 */
export function decide(bot, m, tick, cfg = { regime: REGIME, steward: STEWARD }) {
  const { lower, upper } = bot.params;
  const { price, atr, trendScore } = m;
  const buffer = cfg.steward.breakoutBufferAtr * atr;
  const beyondUp = price > upper + buffer;
  const beyondDown = price < lower - buffer;
  const inside = price >= lower && price <= upper;
  const width = upper - lower;
  const snapshot = {
    price,
    trendScore: Math.round(trendScore * 100) / 100,
    regime: m.regime,
    range: [lower, upper],
  };

  if (bot.status === 'running') {
    if (beyondUp || beyondDown) {
      return {
        action: 'pause',
        reason:
          `price ${fmtPx(price)} broke ${beyondUp ? 'above' : 'below'} the grid ` +
          `${beyondUp ? 'ceiling' : 'floor'} ${fmtPx(beyondUp ? upper : lower)} ` +
          `(beyond the ${cfg.steward.breakoutBufferAtr}xATR buffer); a grid must not ` +
          `${beyondUp ? 'sell into a runaway rally' : 'keep buying into a falling market'}`,
        snapshot,
      };
    }
    if (Math.abs(trendScore) >= cfg.regime.trendThreshold) {
      return {
        action: 'pause',
        reason:
          `strong ${trendScore > 0 ? 'up' : 'down'}trend regime (trend score ` +
          `${fmtNum(trendScore, 2)}, threshold ${cfg.regime.trendThreshold}); grids bleed in trends, ` +
          `pausing until the regime cools`,
        snapshot,
      };
    }
    const edgeDist = Math.min(price - lower, upper - price);
    const cooledDown =
      bot.lastResizeProposalTick == null ||
      tick - bot.lastResizeProposalTick >= cfg.steward.resizeProposalCooldownTicks;
    if (inside && edgeDist < cfg.steward.edgeZonePct * width && cooledDown) {
      const nearUpper = upper - price < price - lower;
      return {
        action: 'propose_resize',
        reason:
          `price ${fmtPx(price)} is drifting near the ${nearUpper ? 'upper' : 'lower'} edge of ` +
          `[${fmtPx(lower)} … ${fmtPx(upper)}] (within ${Math.round(cfg.steward.edgeZonePct * 100)}% of the range width); ` +
          `re-centering would keep both sides of the grid working`,
        snapshot,
      };
    }
    return { action: 'none', reason: 'in range, regime calm', snapshot };
  }

  if (bot.status === 'paused') {
    if (bot.pausedAtTick != null && tick - bot.pausedAtTick < cfg.steward.resumeCooldownTicks) {
      return { action: 'none', reason: 'resume cooldown', snapshot };
    }
    if (inside && isCalm(trendScore, cfg.regime) && (bot.calmStreak ?? 0) >= cfg.steward.resumeCalmStreak) {
      return {
        action: 'resume',
        reason:
          `price ${fmtPx(price)} is back inside [${fmtPx(lower)} … ${fmtPx(upper)}] and the regime has ` +
          `stayed calm ${bot.calmStreak} ticks (trend score ${fmtNum(trendScore, 2)} ≤ ${cfg.regime.calmThreshold}); ` +
          `safe to harvest the range again`,
        snapshot,
      };
    }
    if (
      !inside &&
      bot.outsideSinceTick != null &&
      tick - bot.outsideSinceTick >= cfg.steward.proposeRecenterAfterOutsideTicks
    ) {
      const cooledDown =
        bot.lastResizeProposalTick == null ||
        tick - bot.lastResizeProposalTick >= cfg.steward.resizeProposalCooldownTicks;
      if (cooledDown) {
        return {
          action: 'propose_recenter',
          reason:
            `bot has been paused ${tick - bot.outsideSinceTick} ticks with price ${fmtPx(price)} stranded ` +
            `outside [${fmtPx(lower)} … ${fmtPx(upper)}]; the market may have moved on — consider re-centering`,
          snapshot,
        };
      }
    }
    return { action: 'none', reason: 'waiting for calm range inside grid', snapshot };
  }

  return { action: 'none', reason: `bot is ${bot.status}`, snapshot };
}

/**
 * Run one steward tick: advance the (mock) market, then evaluate and act on
 * every non-stopped bot. Applies pause/resume via the adapter; resize actions
 * are only ever *proposed* (logged). Returns a printable tick report.
 */
export async function runTick(ctx) {
  const { state, okx } = ctx;
  const adv = await okx.advanceMarket(1);
  const tick = state.market?.tick ?? null;

  const report = { tick, simRegime: adv.simRegime ?? null, fills: adv.fills?.length ?? 0, bots: [], actions: [] };

  for (const bot of state.bots) {
    if (bot.status === 'stopped') continue;

    const candles = await okx.fetchCandles(bot.instId, { limit: 60 });
    const m = detectRegime(candles);

    // Track how long price has been outside the range (for re-center proposals)
    // and how long the regime has been calm while inside (resume gating).
    const inside = m.price >= bot.params.lower && m.price <= bot.params.upper;
    if (inside) bot.outsideSinceTick = null;
    else if (bot.outsideSinceTick == null) bot.outsideSinceTick = tick;
    bot.calmStreak = inside && isCalm(m.trendScore) ? (bot.calmStreak ?? 0) + 1 : 0;

    const d = decide(bot, m, tick);
    report.bots.push({ botId: bot.id, instId: bot.instId, status: bot.status, m, decision: d });

    if (d.action === 'pause') {
      await okx.pauseBot(bot.id);
      bot.pausedAtTick = tick;
      report.actions.push(
        appendAction(state, { type: 'auto_pause', botId: bot.id, instId: bot.instId, reason: d.reason, details: d.snapshot })
      );
    } else if (d.action === 'resume') {
      await okx.resumeBot(bot.id);
      bot.pausedAtTick = null;
      report.actions.push(
        appendAction(state, { type: 'auto_resume', botId: bot.id, instId: bot.instId, reason: d.reason, details: d.snapshot })
      );
    } else if (d.action === 'propose_resize' || d.action === 'propose_recenter') {
      bot.lastResizeProposalTick = tick;
      const suggested = planGridParams({
        price: m.price,
        atr: m.atr,
        risk: bot.risk,
        investment: bot.investment,
      });
      report.actions.push(
        appendAction(state, {
          type: d.action === 'propose_resize' ? 'resize_proposed' : 'recenter_proposed',
          botId: bot.id,
          instId: bot.instId,
          reason: d.reason,
          details: {
            ...d.snapshot,
            suggestedRange: [suggested.lower, suggested.upper],
            suggestedGridCount: suggested.gridCount,
            howToApply: `node src/index.js resize ${bot.id} --confirm`,
          },
        })
      );
    }
  }

  return report;
}
