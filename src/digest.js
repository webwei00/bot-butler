// Daily digest: "here's what your bot did" — markdown, written to
// out/digest-<date>.md. Bot status + simulated P&L, every action taken with
// its reason, and regime commentary via the LLM adapter (canned templates in
// mock mode; if LLM_MODE=real is requested but unwired, we fall back visibly).

import fs from 'node:fs';
import path from 'node:path';
import { OUT_DIR } from './config.js';
import { detectRegime } from './regime.js';
import { fmtPx, fmtUsd, fmtSignedUsd, fmtNum, fmtPct, todayStr, nowIso, round2 } from './util.js';

const ACTION_LABELS = {
  propose: 'PROPOSED',
  launch: 'LAUNCHED',
  auto_pause: 'PAUSED (auto)',
  auto_resume: 'RESUMED (auto)',
  resize_proposed: 'RESIZE PROPOSED',
  recenter_proposed: 'RE-CENTER PROPOSED',
  resize_applied: 'RESIZE APPLIED',
  manual_pause: 'PAUSED (manual)',
  manual_resume: 'RESUMED (manual)',
  manual_stop: 'STOPPED (manual)',
};

export async function buildDigest(ctx) {
  const { state, okx, llm } = ctx;
  const date = todayStr();

  // --- market snapshot ---
  const instruments = await okx.listInstruments();
  const snapshot = [];
  for (const inst of instruments.filter((i) => i.major)) {
    const candles = await okx.fetchCandles(inst.instId, { limit: 60 });
    const m = detectRegime(candles);
    const back = candles.length > 24 ? candles[candles.length - 25].c : candles[0].c;
    snapshot.push({
      instId: inst.instId,
      price: m.price,
      chg24: ((m.price - back) / back) * 100,
      atrPct: m.atrPct,
      trendScore: m.trendScore,
      regime: m.regime,
    });
  }

  // --- bots ---
  const bots = [];
  for (const bot of state.bots) {
    bots.push(await okx.getBot(bot.id));
  }
  const totalPnl = bots.reduce((s, b) => s + b.totalPnl, 0);
  const totalFills = bots.reduce((s, b) => s + b.fills, 0);

  // --- actions since the last digest (all of them if this is the first) ---
  const since = state.lastDigestAt;
  const actions = state.actions.filter((a) => !since || a.ts > since);
  const pauses = actions.filter((a) => a.type === 'auto_pause').length;
  const resumes = actions.filter((a) => a.type === 'auto_resume').length;
  const proposalsPending = actions.filter((a) => a.type.endsWith('_proposed'));

  // --- commentary via LLM adapter (canned in mock; visible fallback if real unwired) ---
  // The "dominant" market context is the pair the (active) bots actually trade.
  const activeBots = bots.filter((b) => b.status !== 'stopped');
  const primaryInst = (activeBots[0] ?? bots[0])?.instId;
  const dominant =
    snapshot.find((s) => s.instId === primaryInst) ?? snapshot[0] ?? { regime: 'range', trendScore: 0 };
  const llmCtx = {
    regime: dominant.regime,
    trendScore: dominant.trendScore,
    pauses,
    resumes,
    resizeProposals: proposalsPending.length,
    totalPnl,
    fills: totalFills,
    botCount: activeBots.length || bots.length,
    instIds: [...new Set((activeBots.length ? activeBots : bots).map((b) => b.instId))],
    breakoutSeen: actions.some((a) => a.type === 'auto_pause' && /broke (above|below)/.test(a.reason)),
  };
  let commentary;
  let commentaryNote = '';
  try {
    commentary = await llm.commentary(llmCtx);
  } catch (err) {
    if (err.code === 'LLM_REAL_NOT_WIRED') {
      const { createLlmAdapter } = await import('./adapters/llm.js');
      commentary = await createLlmAdapter({ mode: 'mock' }).commentary(llmCtx);
      commentaryNote = '\n> _Note: LLM_MODE=real is not wired yet (no ANTHROPIC_API_KEY) — this is the canned mock commentary._';
    } else {
      throw err;
    }
  }

  // --- markdown ---
  const L = [];
  L.push(`# Bot Butler — Daily Digest — ${date}`);
  L.push('');
  L.push(`_Mode: **${okx.mode.toUpperCase()}**${okx.mode === 'mock' ? ' (simulated market & fills)' : ''} · generated ${nowIso()} · market tick ${state.market?.tick ?? 'n/a'}_`);
  L.push('');
  L.push('## Market snapshot');
  L.push('');
  L.push('| Pair | Price | Δ 24 candles | ATR/candle | Trend score | Regime |');
  L.push('|---|---:|---:|---:|---:|---|');
  for (const s of snapshot) {
    L.push(
      `| ${s.instId} | ${fmtPx(s.price)} | ${fmtPct(s.chg24)} | ${fmtNum(s.atrPct, 2)}% | ${fmtNum(s.trendScore, 2)} | ${s.regime} |`
    );
  }
  L.push('');
  L.push('## Your bots');
  L.push('');
  if (bots.length === 0) {
    L.push('_No bots yet. Run `node src/index.js propose --budget 500 --risk medium` to get a proposal._');
  } else {
    L.push('| Bot | Pair | Type | Status | Invested | Fills | Realized | Unrealized | Total P&L |');
    L.push('|---|---|---|---|---:|---:|---:|---:|---:|');
    for (const b of bots) {
      L.push(
        `| ${b.botId} | ${b.instId} | ${b.type} | **${b.status}** | ${fmtUsd(b.investment, 0)} | ${b.fills} | ` +
          `${fmtSignedUsd(b.realizedPnl)} | ${fmtSignedUsd(b.unrealizedPnl)} | **${fmtSignedUsd(b.totalPnl)}** |`
      );
    }
    L.push('');
    L.push(
      `**Portfolio: ${fmtSignedUsd(totalPnl)}** across ${bots.length} bot${bots.length === 1 ? '' : 's'} ` +
        `(${round2((totalPnl / Math.max(1, bots.reduce((s, b) => s + b.investment, 0))) * 100)}% on deployed capital, fees included).`
    );
  }
  L.push('');
  L.push(`## Actions taken (${actions.length})`);
  L.push('');
  if (actions.length === 0) {
    L.push('_No interventions — the market stayed within policy. That is a feature, not a bug._');
  } else {
    for (const a of actions) {
      const label = ACTION_LABELS[a.type] ?? a.type;
      const who = a.botId ? ` ${a.botId}${a.instId ? ` (${a.instId})` : ''}` : a.instId ? ` ${a.instId}` : '';
      L.push(`- \`t=${a.tick ?? '–'}\` **${label}**${who} — ${a.reason}`);
    }
  }
  L.push('');
  if (proposalsPending.length) {
    L.push('## Waiting on you');
    L.push('');
    for (const p of proposalsPending) {
      const r = p.details?.suggestedRange;
      L.push(
        `- ${p.botId}: suggested new range ${r ? `[${fmtPx(r[0])} … ${fmtPx(r[1])}]` : '(recompute at apply time)'} — apply with \`${p.details?.howToApply ?? 'node src/index.js resize <botId> --confirm'}\``
      );
    }
    L.push('');
  }
  L.push("## Butler's commentary");
  L.push('');
  L.push(commentary + commentaryNote);
  L.push('');
  L.push('---');
  L.push(
    '_Safety rails: hard allocation caps, majors-only default, auto pause/resume authorized by you at launch, ' +
      'resizes require your explicit confirmation, and every action above comes from the append-only log. No silent changes._'
  );
  L.push('');

  return { date, markdown: L.join('\n'), actions: actions.length, totalPnl };
}

export async function writeDigest(ctx) {
  const digest = await buildDigest(ctx);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `digest-${digest.date}.md`);
  fs.writeFileSync(file, digest.markdown);
  ctx.state.lastDigestAt = nowIso();
  return { ...digest, file };
}
