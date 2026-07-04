// Launch flow: proposal -> (explicit confirmation handled by the caller) ->
// re-check every hard cap -> create via the adapter -> log. Confirmation
// itself lives in the CLI (prompt or --confirm) / demo; this module refuses
// to run unless the caller states how consent was given.

import { CAPS, MAJORS } from './config.js';
import { appendAction } from './state.js';
import { fmtUsd } from './util.js';

/**
 * Launch a confirmed proposal. `confirmedBy` documents how consent was given
 * ('--confirm flag', 'interactive y', 'demo --confirm') and is recorded in
 * the action log.
 */
export async function launchProposal(ctx, proposalId, { confirmedBy } = {}) {
  const { state, okx } = ctx;
  if (!confirmedBy) {
    throw new Error('Safety rail: launchProposal requires confirmedBy — launches must be explicitly confirmed.');
  }

  const proposal = state.proposals.find((p) => p.id === proposalId);
  if (!proposal) throw new Error(`Unknown proposal '${proposalId}'.`);
  if (proposal.status !== 'proposed') {
    throw new Error(`Proposal ${proposalId} is '${proposal.status}' — only 'proposed' proposals can launch.`);
  }

  // --- hard caps re-checked at launch (defense in depth; state may have changed) ---
  const activeBots = state.bots.filter((b) => b.status !== 'stopped');
  if (activeBots.length >= CAPS.maxActiveBots) {
    throw new Error(`Cap: max ${CAPS.maxActiveBots} active bots reached.`);
  }
  if (proposal.investment > CAPS.maxAllocationPerBot) {
    throw new Error(`Cap: ${fmtUsd(proposal.investment, 0)} exceeds the ${fmtUsd(CAPS.maxAllocationPerBot, 0)} per-bot cap.`);
  }
  const committed = activeBots.reduce((s, b) => s + b.investment, 0);
  if (committed + proposal.investment > CAPS.maxTotalAllocation) {
    throw new Error(
      `Cap: total allocation would reach ${fmtUsd(committed + proposal.investment, 0)}, ` +
        `over the ${fmtUsd(CAPS.maxTotalAllocation, 0)} cap.`
    );
  }
  if (!MAJORS.includes(proposal.instId) && !proposal.input.preference.includes('alts')) {
    throw new Error(`Safety rail: ${proposal.instId} is not a major and alts were not explicitly opted into.`);
  }

  const botId = `bot-${++state.counters.bot}`;
  const spec = {
    id: botId,
    instId: proposal.instId,
    type: proposal.botType,
    params: proposal.params,
    investment: proposal.investment,
    risk: proposal.input.risk,
    proposalId: proposal.id,
  };
  const res = await okx.createBot(spec);

  proposal.status = 'launched';
  proposal.botId = botId;
  appendAction(state, {
    type: 'launch',
    botId,
    instId: proposal.instId,
    reason: `User confirmed proposal ${proposal.id} (${confirmedBy}) — ${proposal.botType.toUpperCase()} on ` +
      `${proposal.instId}, ${fmtUsd(proposal.investment, 0)} deployed. Stewardship policy (auto pause/resume) authorized.`,
    details: { params: proposal.params, confirmedBy },
  });

  return state.bots.find((b) => b.id === botId) ?? { id: botId, ...spec, status: res.status };
}
