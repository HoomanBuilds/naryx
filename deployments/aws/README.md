# Hosting: Vercel web, one AWS host for the services

| Part | Where | Why |
|---|---|---|
| `apps/web` (landing and terminal) | Vercel | Static Next.js pages; the browser talks to the chains, wallets, and the API directly |
| `services/api`, `services/solver`, `services/keeper`, `services/indexer` | One AWS EC2 instance | They must run 24/7 and they call each other only over `127.0.0.1`, so they belong on one host |
| Databases | SQLite files on that instance's EBS volume, backed up hourly to S3 | See "Database" below |

```
browser (any user, any wallet)
  |-- https --> Vercel: static web app
  |-- wallets sign and send to Solana Devnet, Base Sepolia, Arbitrum Sepolia
  `-- https --> api.<domain> (Elastic IP) --> nginx --> 127.0.0.1:8787 API
                                                        |-- 127.0.0.1:8788 solver (+ lane executors 8792-8795)
                                                        |-- 127.0.0.1:8789 keeper
                                                        `-- indexers (one per EVM network)
```

## Database

No Postgres is needed. The services keep their state in about 28 SQLite stores (`better-sqlite3`,
WAL, `synchronous = FULL`) whose money and authorization paths rely on synchronous transactions:
an execution cap decision, an order, and an attempt are recorded atomically in one process. On a
single host that is the fastest and safest design, and the files survive restarts on the EBS volume.
Moving to Postgres would mean rewriting every store as asynchronous code for no gain at this scale,
and a free Supabase project pauses when inactive, which would take trading down with it. Durability
comes from hourly online backups to S3 (`backup.sh`, `naryx-backup.timer`) plus EBS snapshots.

## 1. The instance

- Ubuntu 24.04 LTS, `t3.medium` (2 vCPU, 4 GiB; the TypeScript builds need the memory), 40 GiB gp3.
- An Elastic IP, and a DNS `A` record `api.<your domain>` pointing at it.
- Security group inbound: 443 and 80 from anywhere (80 only for the certificate challenge and the
  HTTPS redirect). SSH from your own IP only, or no SSH at all with AWS Systems Manager Session Manager.
  Nothing else: every service port listens on `127.0.0.1` only.
- An IAM instance role allowing `s3:PutObject` and `s3:ListBucket` on the backup bucket prefix.
  No AWS access keys on the host.
- Enable EBS daily snapshots (Data Lifecycle Manager) as a second backup.

## 2. Install

```bash
sudo apt-get update
sudo apt-get install -y git build-essential python3 nginx certbot python3-certbot-nginx
sudo snap install aws-cli --classic
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs   # Node 22
sudo npm install -g npm@11.21.0   # the lockfiles are npm 11; Node 22's bundled npm 10 refuses them in npm ci

sudo useradd --system --home-dir /srv/naryx --create-home --shell /usr/sbin/nologin naryx
sudo -u naryx mkdir -p /srv/naryx/data /srv/naryx/release /srv/naryx/keys /srv/naryx/backups
sudo chmod 700 /srv/naryx/keys
sudo -u naryx git clone <repository URL> /srv/naryx/app
sudo -u naryx /srv/naryx/app/deployments/aws/build.sh
```

Copy the testnet key files (solver EVM and Solana keys, the Hyperliquid agent key, the funding
keeper keys) into `/srv/naryx/keys`, owned by `naryx`, mode `600`. Fill the release templates with
those paths (see `deployments/GO-LIVE.md`).

## 3. Generate the configuration

Run the release generator on the host as the `naryx` user (it writes every file readable by its
owner only, and the services run as `naryx`), with `--out /srv/naryx/release --data-dir
/srv/naryx/data` (`deployments/tools/README.md`, environment from `deployments/.env.example`):
`sudo -u naryx node deployments/tools/release-manifests.mjs ...`. Set the API's
`NARYX_TERMINAL_ORIGIN` in the common release to the web origins, comma-separated, for example
`https://naryx.vercel.app,https://app.<your domain>` (each exact; no wildcards). A Vercel preview
deployment gets its own origin and is refused unless listed; leave
`NEXT_PUBLIC_PRIVATE_TERMINAL_API_BASE_URL` unset in Vercel's Preview environment so previews run
on the labeled local fixture.

## 4. Services

```bash
sudo cp /srv/naryx/app/deployments/aws/systemd/*.service /srv/naryx/app/deployments/aws/systemd/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now naryx-api naryx-solver naryx-keeper
sudo systemctl enable --now naryx-indexer@base-sepolia naryx-indexer@arbitrum-sepolia
echo 'NARYX_BACKUP_S3_URI=s3://<bucket>/naryx-testnet' | sudo tee /srv/naryx/backup.env
sudo systemctl enable --now naryx-backup.timer
journalctl -u naryx-api -f      # logs
```

Each unit restarts on failure, runs as `naryx`, and can write only `/srv/naryx/data`.

## 5. HTTPS and the route allowlist

```bash
sudo cp /srv/naryx/app/deployments/aws/nginx/naryx-proxy.conf /etc/nginx/snippets/
sudo cp /srv/naryx/app/deployments/aws/nginx/naryx-api.conf /etc/nginx/sites-available/
sudo sed -i 's/api.naryx.example/api.<your domain>/' /etc/nginx/sites-available/naryx-api.conf
sudo ln -s /etc/nginx/sites-available/naryx-api.conf /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.<your domain>
```

nginx forwards only `/internal/healthz` and `/internal/terminal/`, refuses raw paths with
backslashes, encoded dots or slashes, and dot segments, and limits each client IP (30 requests per
second for reads, 5 for writes, with bursts). The API itself also refuses any proxied request on its
solver, keeper, and executor routes and any backslash path, so a proxy mistake cannot expose them.

## 6. Vercel

- Import the repository; Framework Next.js; Root Directory `apps/web`; Install `npm ci`;
  Build `npm run build`; Node.js 22.x.
- The frontend is a static export. Keep the Next.js framework preset and its default Output
  Directory setting so exported page and client-navigation routes are handled. Do not set the
  Vercel Output Directory to `out`: its Next.js builder first reads `.next` manifests before
  publishing the exported assets, and an override makes it look for those manifests in `out`.
  Security headers run at the CDN level, not in middleware. All application requests go
  directly to AWS. Verify zero functions in the deployment output before promotion. CDN and
  build usage remain separate from Fluid active CPU; do not add request-time Vercel compute.
- Environment variables (Production): the values from the generated `web/.env.production`.
  `NEXT_PUBLIC_*` values are compiled in at build time, so redeploy after changing any.
- `NEXT_PUBLIC_PRIVATE_TERMINAL_API_BASE_URL` is `https://api.<your domain>`.
- Run Vercel CLI deployments from the repository root. The project already sets Root Directory
  to `apps/web`; invoking it from that workspace resolves `apps/web/apps/web` and fails.
  Keep the root `.vercelignore` upload filter: only `apps/web`, `packages/protocol-types`, and
  `packages/sdk` application sources belong in the upload. Use explicit directory exclusions;
  this CLI skips traversal under a blanket `*` despite nested re-inclusion rules. A deployment
  without this filter selected about 2 GB of local artifacts despite Git ignores and was stopped
  before completion. Do not rely
  on Git ignores alone or upload local secrets, caches, contract builds, or backend services.
  Stage with `vercel deploy --prod --skip-domain`, check the staged deployment, then promote it.
- Static hosting was verified on 2026-10-18 in deployment `dpl_FiQpQ7mvfDxKkLCenu11AKCzCiiE`,
  promoted to `naryx.xyz`. Vercel reported zero runtime outputs. All seven pages, robots, sitemap,
  and the 404 response preserved security headers; browser navigation across all six terminal
  views produced no page errors or failed same-origin assets. The earlier deployment exposed
  42 lambda route outputs. Historical usage and requests to older deployment URLs are separate;
  this check is not a claim that other projects or previous deployments consume no resources.

## 7. Operating

- Encrypted solver openings: enable `NARYX_SEALED_AUCTION_THRESHOLD_ENABLED=true` in the solver
  environment only after deploying the threshold-capable API and solver together. Preserve the
  private-delivery and solver-auction SQLite journals in the rollback backup. The solver requires
  a compatible Unix-clock auction with more than 60 seconds after beacon release for verification;
  shorter auctions retain ordinary commit/reveal. Check the installed crypto dependency before
  restart, then restart only `naryx-api` and `naryx-solver`. For an isolated live-beacon check, run
  `node tests/phase10-demo/src/run-threshold-release.mjs --output <new-private-directory-outside-checkout>`
  from the deployed checkout as the service user. This creates its own evidence database and
  does not create public trades, transfer tokens or execute a strategy.
- Dedicated test-pool browser access: after deploying the pool controller, run
  `sudo -u naryx node /srv/naryx/app/deployments/tools/wire-testnet-pool-browser.mjs --root /srv/naryx`
  and then `--apply`. It verifies the test pool, preserves existing API settings, and enables
  the restricted proxy and timed threshold openings. Restart only `naryx-api` afterward.
  Wait for `/health` after a controller restart before running this probe. A restart acknowledgement
  alone does not mean the listener is ready. Keep the private-delivery SQLite backup for rollback.
- Health: `curl https://api.<your domain>/internal/healthz`; point an uptime monitor (for example a
  Route 53 health check) at it.
- Incident visibility: run `sudo -u naryx node /srv/naryx/app/deployments/tools/wire-keeper-status.mjs --root /srv/naryx`
  to inspect the keeper endpoint before applying the same command with `--apply`. The tool derives
  the actual loopback port, probes the status schema, preserves other settings and makes an
  owner-only backup before updating `api.env`. Restart only `naryx-api` afterward. An unavailable
  scope remains unavailable; wiring this reader does not create qualification evidence, restore
  a quarantined dependency, or activate trading. Preserve `NARYX_KEEPER_STATUS_ORIGIN` in regenerated
  releases using the generator's environment input.
- Incident state guards were deployed to the API and keeper on 2026-10-18. Revoked readiness
  no longer prevents a code-drift quarantine, activation requires safe exits, and fresh paused
  incident scopes still degrade health. The configured Solana incident journal is absent and
  its watchlist decision is NOT_READY with no evidence or funded operations. Do not create an
  ACTIVE journal from matching code hashes alone: a reviewed release decision with its authority
  inventory, caps, funded-operation manifests, security review, and current evidence is required.
  The testnet execution-cap policy is separate from that qualification. The rollback archive is
  `/srv/naryx/backups/20261018-incident-state-guards/code-before.tar.gz`.
- Deploy a new commit: `git pull`, `deployments/aws/build.sh`, regenerate the release if any
  template or deployment changed, then `sudo systemctl restart naryx-api naryx-solver naryx-keeper`.
  The generator refuses a non-empty `--out`, so regenerate as `naryx` into a new directory
  (`--out /srv/naryx/release.next`, same `--data-dir`), then swap it in:
  `mv /srv/naryx/release /srv/naryx/release.prev && mv /srv/naryx/release.next /srv/naryx/release`,
  and restart. The data directory is untouched; keep `release.prev` until the restart is healthy.
- Restore: stop the services, copy a snapshot from S3 into `/srv/naryx/data` (same relative paths),
  start the services.
- Fund the solver, keeper, and Hyperliquid accounts before they run dry; their balances bound how
  many users can trade at once.
- The optional Solana Devnet Pyth pusher keeps the SOL/USD shard-0 account fresh when the sponsored
  updater is slow. Its own Devnet wallet is separate from the solver. It needs an independent
  `NARYX_PYTH_DEVNET_RPC_URL`: the shared public Devnet RPC returned 429 errors under the pusher's
  workload, so the runtime guard refuses that endpoint. Generate its secret-bearing
  JSON with `node --env-file=deployments/.env deployments/tools/prepare-pyth-devnet-pusher.mjs
  <ignored-output-path>`, then install it as `/srv/naryx/release/pyth-pusher.json` (mode 600,
  owner `naryx`). Install `deployments/aws/pyth-sol-usd.yaml` beside it and a funded Devnet-only
  keypair as `/srv/naryx/keys/pyth-pusher.json`, both mode 600. Build the pinned upstream
  `pyth-price-pusher-v10.5.0` tag for this ARM64 host with
  `deployments/aws/Dockerfile.pyth-pusher-arm64`, install
  `deployments/aws/systemd/naryx-pyth-pusher.service`, and enable that unit. Adjust its container
  UID:GID if the host's `naryx` account is not `995:987`. Every service start verifies the RPC's
  actual Devnet genesis hash before attaching the signer. The Pyth API key may be a free trial, not
  a guaranteed free production entitlement. If this pusher or its key stops working, the existing
  sponsored shard-0 account remains the fallback; Naryx still refuses prices older than its
  configured safety limit.
- A Hyperliquid package whose outcome is not final blocks the shared lane (new Hyperliquid
  executions wait, then time out). The solver re-reads fresh evidence for it every 30 s and releases
  the lane by itself once that evidence shows the outcome is final, and the API then updates the
  owner's package. If it stays blocked (interrupted before any result, or never reconciling),
  resolve it and release the lane on the host itself:

  ```bash
  curl -sS -X POST http://127.0.0.1:8792/internal/solver/hyperliquid-testnet/release-lane \
    -H 'Content-Type: application/json' \
    -d '{"attemptId":"<blocked attempt id>","disposition":"FINAL","reason":"reconciled after fill"}'
  ```

  `FINAL` succeeds only while a fresh keeper reconciliation shows nothing pending; for an attempt
  resolved out of band use `ABANDONED` with a reason (`deployments/hyperliquid/testnet/README.md`).
