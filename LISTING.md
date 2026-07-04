# OKX.AI Listing Manifest — Bot Butler

The submission record for listing this agent on OKX.AI. Listing is an **on-chain
identity + service registration on X Layer** via the Onchain OS CLI — not a web
form. Fill the two `REPLACE_*` placeholders, then run the command sequence below.

## Canonical manifest

```json
{
  "role": "asp",
  "identity": {
    "name": "Bot Butler",
    "description": "Bot Butler designs a grid or DCA trading bot from a plain-English brief — your budget, risk appetite and preferred pairs — then keeps stewarding it: pausing in breakouts, resuming in range, proposing range resizes, and sending a daily digest of every action it took and why. Confirmation-gated, with hard allocation caps. Set it, but never forget it.",
    "avatar_file": "./brand/avatar.png",
    "preferred_language": "en"
  },
  "services": [
    {
      "name": "Grid & DCA Bot Steward",
      "description": "Proposes a risk-sized grid or DCA bot (pair, range, spacing, capital) with clear reasoning, launches it on your confirmation, then monitors market regime and manages the bot daily with a full action log and digest. You supply: an OKX API key with trade permission, your budget, and a risk level (low, medium or high).",
      "type": "A2MCP",
      "fee": "8",
      "fee_currency": "USDT",
      "endpoint": "https://REPLACE_WITH_YOUR_DEPLOY_HOST/api/propose"
    }
  ]
}
```

- **`REPLACE_WITH_YOUR_DEPLOY_HOST`** → your deployed domain. The local entry route
  is `POST /api/propose` (then `/api/launch`, `/api/tick`, `/api/digest` — see
  [STATUS.md](STATUS.md)); must be a public `https://` URL (permanent on-chain).
- **`avatar.png`** → required uploaded image. Concierge identity: brass bowtie /
  service-bell motif on deep navy. Put it at `brand/avatar.png`.
- **fee** `"8"` = 8 USDT to design + launch a bot (stewardship included). Adjust
  freely; digits only, ≤6 decimals, currency is USDT.

## Registration command sequence

```bash
# 0. Wallet session (TEE) — identities live on X Layer only, never pass --chain
onchainos wallet status --format json
onchainos wallet login <your-email>        # then: onchainos wallet verify <code>

# 1. Consent / eligibility (one ASP identity per wallet)
onchainos agent pre-check --role asp

# 2. Upload the avatar, capture the returned URL for --picture
onchainos agent upload --file ./brand/avatar.png

# 3. Automated listing QA — fix any findings before create
onchainos agent validate-listing --role asp \
  --name "Bot Butler" \
  --description "Bot Butler designs a grid or DCA trading bot from a plain-English brief — your budget, risk appetite and preferred pairs — then keeps stewarding it: pausing in breakouts, resuming in range, proposing range resizes, and sending a daily digest of every action it took and why. Confirmation-gated, with hard allocation caps. Set it, but never forget it." \
  --service '[{"name":"Grid & DCA Bot Steward","description":"Proposes a risk-sized grid or DCA bot (pair, range, spacing, capital) with clear reasoning, launches it on your confirmation, then monitors market regime and manages the bot daily with a full action log and digest. You supply: an OKX API key with trade permission, your budget, and a risk level (low, medium or high).","type":"A2MCP","fee":"8","endpoint":"https://REPLACE_WITH_YOUR_DEPLOY_HOST/api/propose"}]'

# 4. Create the on-chain identity → returns newAgentId
onchainos agent create --role asp \
  --name "Bot Butler" \
  --description "<same description as above>" \
  --picture "<url from step 2>" \
  --service '<same --service JSON as above>'

# 5. Activate → submits for review / publishes
onchainos agent activate --agent-id <newAgentId> --preferred-language en
```

On-chain fees are covered by OKX (X Layer is gas-free). Settlement is in USDT.

## Owner values — REGISTERED (Jul 3, 2026)

| Field | Value |
|---|---|
| **Agent ID** | **3621** (X Layer, chain 196) |
| Registration tx | `0x1e9e4cadd64e1dc480a8ded48fbab47fe87187db4eb4f091724fcab118af6e68` |
| Status | **submitted for review** (`approvalStatus: 2`); result → owner email within ~2 business days; usable via Agent ID meanwhile |
| Owner email / wallet login | wisdomemmanuelenang@gmail.com |
| Payout wallet (X Layer, `X402_PAY_TO`) | `0xdbaed306f16a5b1020b4b0799fa2d2907296735a` |
| Avatar (uploaded) | `https://static.okx.com/cdn/web3/wallet/marketplace/headimages/agent/avatar/09253a67-3ce5-4f8e-b495-5f83e1dde2a4.png` |
| Endpoint (on-chain, permanent) | `https://bot-butler-production.up.railway.app/api/propose` — passes `agent x402-check` (`valid: true`) |
| Repo | github.com/webwei00/bot-butler |
| Service | Grid & DCA Bot Steward, A2MCP, 8 USDT/call |

**Later, for real bot operations:** needs an OKX exchange API key (trade permission)
+ small funded test account — separate from the x402 payment creds, only when moving
the strategist off simulation.

**Registration schema (proven — use exactly):** `--service` keys camelCase
(`serviceName`/`serviceDescription`/`serviceType`/`fee`/`endpoint`);
`serviceDescription` two lines (capability `\n` what-user-supplies); endpoint must
pass `onchainos agent x402-check` (x402 v2 gate already fixed in this repo).

## Owner checklist

- [x] x402 pay-per-call layer built on `POST /api/propose` (HTTP 402 handshake, 8 USDT =
      `maxAmountRequired:"8000000"` on X Layer `eip155:196`) — **mock mode verified**
      end-to-end via `npm run x402-demo` + `test/x402.test.js`. Real mode needs
      facilitator creds (`OKX_X402_API_KEY/SECRET/PASSPHRASE`) and `X402_PAY_TO`
      (owner wallet); endpoint/header names are ASSUMED pending OKX docs — see
      STATUS.md "x402 payment layer". Enable with `X402_MODE=mock|real` (default `off`).
- [ ] Deploy the service; set the real `https://` endpoint (replace the placeholder)
- [x] Create `brand/avatar.png` — done (1024×1024, brass service bell + bow tie on navy; editable source at `brand/avatar.svg`)
- [ ] Register hackathon + OKX Onchain OS dev-portal creds (`.env`); fund a small
      OKX test account for live bot verification
- [ ] Run steps 0-5 above; record `newAgentId`
- [ ] Confirm activation status (submitApproval → under review)
- [ ] Submit the hackathon Google form before **Jul 17 00:00 UTC**
- [ ] Post the ≤90s demo on X with **#okxai**
