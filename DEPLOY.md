# Deploying Bot Butler

Zero-dependency Node app — no build step. Any Node 18+ host works; Railway and
Render one-click from GitHub are the fastest paths.

## 1. Push to your GitHub

This folder is a standalone git repo. Create an empty repo on your GitHub
(e.g. `bot-butler`), then:

```bash
git remote add origin https://github.com/<your-username>/bot-butler.git
git push -u origin main
```

## 2. Create the service (Railway shown; Render is equivalent)

1. railway.app → New Project → **Deploy from GitHub repo** → pick `bot-butler`
2. It auto-detects Node and uses `npm start` (wired to `node src/server.js`)
3. The server reads `PORT` from the environment automatically — no config needed
4. Settings → **Networking → Generate Domain** → this is your public URL

## 3. Environment variables

| Variable | Value | When |
|---|---|---|
| `X402_MODE` | `mock` | now — endpoint demonstrates the full 402 handshake without creds |
| `X402_PAY_TO` | `0xdbaed306f16a5b1020b4b0799fa2d2907296735a` | now — owner payout wallet (X Layer) |
| `OKX_X402_API_KEY` | from web3.okx.com/onchain-os/dev-portal | before charging real money |
| `OKX_X402_SECRET` | 〃 | 〃 |
| `OKX_X402_PASSPHRASE` | 〃 | 〃 |
| then set `X402_MODE` | `real` | 〃 |

Note: running **real bot operations** (live grid/DCA on OKX) additionally needs an
OKX exchange API key with trade permission + a small funded test account — that is
separate from the x402 payment creds above and only needed once you move the
strategist off simulation. The listing itself does not require it.

## 4. Verify

```
https://<your-domain>/api/health   → {"ok":true,...}
https://<your-domain>/             → dashboard
POST https://<your-domain>/api/propose  → 402 challenge (when X402_MODE≠off)
```

## 5. Register the endpoint

Your on-chain service endpoint (permanent) is:

```
https://<your-domain>/api/propose
```
