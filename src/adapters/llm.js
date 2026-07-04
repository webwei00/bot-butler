// LLM adapter for the digest's "butler commentary".
//
//   LLM_MODE=mock (default)  Canned, context-aware templates — deterministic,
//                            zero deps, works offline.
//   LLM_MODE=real            Stub documenting the exact Anthropic API call the
//                            wiring is expected to make. The digest catches the
//                            error and falls back to the canned template with a
//                            visible note, so digests never break.

import { fmtSignedUsd, fmtNum } from '../util.js';

export function createLlmAdapter({ mode = (process.env.LLM_MODE || 'mock').toLowerCase() } = {}) {
  return {
    mode,

    /**
     * ctx: { regime, trendScore, pauses, resumes, resizeProposals, totalPnl,
     *        fills, botCount, breakoutSeen, instIds: [] }
     */
    async commentary(ctx) {
      if (mode === 'real') {
        const err = new Error(
          `[LLM real mode] commentary() is not wired yet.\n` +
            `  Expected integration: POST https://api.anthropic.com/v1/messages\n` +
            `    model: "claude-sonnet-4-5", max_tokens: 300\n` +
            `    system: "You are Bot Butler, a careful steward of grid trading bots. ` +
            `Write 3-4 plain-English sentences for a daily digest: what the market did, ` +
            `what actions you took and why, and the outlook. No hype, no advice."\n` +
            `    messages: [{ role: "user", content: JSON.stringify(digestContext) }]\n` +
            `  Requires env: ANTHROPIC_API_KEY\n` +
            `  Falling back to canned template (LLM_MODE=mock).`
        );
        err.code = 'LLM_REAL_NOT_WIRED';
        throw err;
      }
      return cannedCommentary(ctx);
    },
  };
}

// --- canned templates (mock mode) -----------------------------------------

function cannedCommentary(ctx) {
  const {
    regime = 'range',
    trendScore = 0,
    pauses = 0,
    resumes = 0,
    resizeProposals = 0,
    totalPnl = 0,
    fills = 0,
    botCount = 0,
    instIds = [],
    breakoutSeen = false,
  } = ctx;

  const pair = instIds[0] ?? 'the market';
  const pnlPhrase =
    totalPnl >= 0
      ? `Net P&L stands at ${fmtSignedUsd(totalPnl)} — the grid earned its keep`
      : `Net P&L stands at ${fmtSignedUsd(totalPnl)} — inventory is marked against us for now`;

  if (pauses > 0 && resumes > 0) {
    const trigger = breakoutSeen
      ? `${pair} broke clean out of its grid range, so I stepped in and paused the bot ` +
        `rather than let it sell into a runaway move`
      : `${pair} started trending hard (trend score past my 1.1 threshold), so I paused the grid ` +
        `before it could fill one-sided — it never even had to wait for the range to break`;
    return (
      `An eventful stretch. ${trigger}. ` +
      `When the move exhausted itself and the regime cooled back into a range, I resumed the bot — ` +
      `${fills} fills captured along the way. ${pnlPhrase}.` +
      (resizeProposals > 0
        ? ` Price is leaning toward one edge of the grid, so there's a resize proposal waiting for your confirmation.`
        : ` No action needed from you.`)
    );
  }
  if (pauses > 0) {
    return (
      `${pair} is trending (score ${fmtNum(trendScore, 2)}) and pushed beyond the configured grid range, ` +
      `so I paused the bot to protect it from one-sided fills. I'll resume automatically once the regime ` +
      `cools back into a range. ${pnlPhrase}.` +
      (resizeProposals > 0 ? ` A re-center proposal is queued for your confirmation.` : '')
    );
  }
  if (regime === 'range') {
    return (
      `Quiet, textbook grid weather: ${pair} oscillated inside its range (trend score ${fmtNum(trendScore, 2)}), ` +
      `and the ${botCount === 1 ? 'bot' : `${botCount} bots`} harvested ${fills} fills without needing intervention. ` +
      `${pnlPhrase}. I'll keep watching for regime changes.`
    );
  }
  return (
    `${pair} is showing directional pressure (trend score ${fmtNum(trendScore, 2)}). Nothing has crossed my ` +
    `intervention thresholds yet, but I'm watching closely and will pause the grid if this develops into a breakout. ` +
    `${pnlPhrase}.`
  );
}
