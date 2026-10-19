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

- Native EVM conformance oracles need maintenance independently of the live cash-mark worker.
  On 2026-10-18 both fixed-price test oracles exceeded their 24-hour heartbeat, so treasury
  quotes reverted with `StaleOraclePrice()` and a sealed auction correctly closed with no fill.
  The owner-operated refresh tool restored the same test answers. Base receipt:
  `0xffa4a862a18c6dcd09431677057c9e66ed80189222be569cdba8531d4f36e22c`;
  Arbitrum receipt: `0xef9243087de8fba467a41a3efde299165f5d1ae7a887c1e68b77e89a743428c1`.
  Subsequent ordinary commit/reveal auctions reached `AWARDED` and persisted signed quotes on
  both domains: Base `67cfb368842b11dc60bacf04b0df0b9906d5e1ad6aaabb8c6613dbe18514fe8a`,
  Arbitrum `82e2c85c896bbb3e9d25872ba6d6899c6d5062e887d8e385226f6455cc4db2e2`.
  These checks placed no funded strategy trade and do not verify threshold auctions. Check
  freshness with `deployments/tools/refresh-evm-conformance-oracles.mjs` before operation.
  The `naryx-conformance-oracle@base-sepolia.timer` and
  `naryx-conformance-oracle@arbitrum-sepolia.timer` units check hourly and refresh after half the
  heartbeat. Provision the explicitly approved owner key at
  `/srv/naryx/keys/conformance-oracle-owner.json` (owner `naryx`, mode 600), and the two testnet
  RPC variables in `/srv/naryx/release/env/conformance-oracles.env`. The key retains its owner's
  full authority; application restrictions do not narrow the key's cryptographic permissions.
  Keep it out of application responses, logs, frontend builds, and repository history.
  Create `/srv/naryx/data/conformance-oracles` with owner `naryx`, mode 700, install the two unit
  templates, and enable each timer only after a successful bounded refresh and restart check.
  Preserve both SQLite journals and their WAL files: they enforce the per-network 0.001 test
  ETH reservation budget and pending-transaction recovery. Base ancillary fees are preflighted
  with headroom, reconciled after inclusion, and halt on overrun; they are not transaction-capped.
  Disable the timers before manual
  owner operations to avoid nonce contention. This service neither updates live-price feeds
  nor changes any market, deployment, or oracle owner.
  Both timers were activated on 2026-10-18 after confirmed test refreshes: Base
  `0x9216170ddf8d2958252b286612a470e745973a3b11834c6bcff7dcd4ad6cdc70`
  and Arbitrum `0x3e993a20c7e522c4809abcf57698c39cc0513f07721d6c7b1c8b630ee92e05d5`.
  Base's initial receipt check failed; the next invocation recovered the already-mined hash
  from its journal without signing another transaction. Both journals recorded confirmation.
- Native cash marks also require funded updater wallets; an active process alone is insufficient.
  On 2026-10-18 the Arbitrum updater had only 851064026000 wei despite a fresh source feed, and
  its cash mark had expired. A journaled 0.0002 test ETH top-up restored updates without a
  contract change or test USDC mint. Funding receipt:
  `0x8bd6962884288a7d81c0a5285e5d84cf0c414a9bed49f8dc2e172ee78f359189`.
  The native mark journal conservatively charges both the transferred value and maximum gas
  against its existing allowance. Insufficient-gas failures now have an explicit log message.
  Check the public standing book's `validUntil` and actual bid/ask capacity, not just systemd.
- Approved quote-worker gas top-ups on 2026-10-19 restored freshness without a restart or
  collateral change. The Solana worker received 0.05 Devnet SOL in
  `3bMrLfgSzkE7zJfkuUNRMob745ac6BMNabUQJBPxb8bLKD8hWXPYNEJgxQDscuzmQhTaqEwUjL9ieiTTKT1NJFCK`;
  its standing ask resumed with 450 units of capacity, while its bid remained absent.
  The Arbitrum mark updater received 0.0002 Sepolia ETH in
  `0x53acc43e3246510fed4baa50882b4b2ee00e46a3d4c99b1c984e491983e40660`;
  its funded cash book resumed with five units on each side and an unexpired mark.
  Existing gas-budget journals and caps remain unchanged. These are distinct quote sources,
  not resting liquidity in the routed strategy books.
- Cash mark retries use the signed transaction hash as their journal identity. A reverted
  transaction does not advance the contract's mark sequence, so using that sequence as a
  unique database key permanently blocks retries. Preserve reverted rows and their gas
  reservations; never delete journal entries or reset a budget to restore quote updates.
- Package depth streaming uses the same domain clock as HTTP depth. Solana expiry is in
  slots, EVM expiry is in seconds, and Hyperliquid expiry is in milliseconds. Compare the
  same market's HTTP and streaming `asOfValue` when diagnosing disappearing quotes.
- Publish a coherent source and compiled artifact set from a successful checkout build.
  Do not rebuild a partially synchronized service on AWS: older source or dependency
  declarations can fail compilation while TypeScript still overwrites running artifacts.
  Back up the full affected service output before deployment, not only the edited files.
- Native cash standing-book reads tolerate a qualified oracle/clearing mark update window.
  After checking pinned code, bindings, freshness, bounds and fees, a price mismatch retries
  up to five observations with one-second spacing and an eight-second response deadline.
  Concurrent requests share only an in-flight read, never cached executable quotes. Remaining
  refreshes return `503 MARK_REFRESHING`; a stalled read returns `503 BOOK_READ_TIMEOUT`.
  Other validation failures still refuse the book. Deployed on 2026-10-18 from `5888323c`;
  Base and Arbitrum returned funded five-unit bid/ask books afterward. Historical Arbitrum
  block `320301345` reproduced the refresh condition without changing contract validation.
  The rollback archive is `/srv/naryx/backups/standing-book-refresh-20261018/runtime-before.tgz`.
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
  On 2026-10-18 both approved trader wallets completed sequential 2 mock-USDC browser
  deposit/withdrawal cycles, including signed reads and post-reload checks. The venue and
  database ended with zero pool cash, liabilities and pending operations. The GO-LIVE record
  contains all four transfer hashes. Preserve the `browser-cycle-20261018-owner-1` and
  `browser-cycle-20261018-owner-2` operator journals: an existing deposit intent is observed,
  never resent. This check authorized no epoch trade and no new standing pool funding.
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
  A fresh read-only observation on 2026-10-18 confirmed all five watched program hashes match.
  Its report is `/srv/naryx/release/recovery/qualification-observation.json`; it records the absent
  journal and NOT_READY decision, not a replacement qualification. Current release evidence and
  the required security-review attestation still need to be assembled and approved.
- Deploy a new commit: `git pull`, `deployments/aws/build.sh`, regenerate the release if any
  template or deployment changed, then `sudo systemctl restart naryx-api naryx-solver naryx-keeper`.
  The generator refuses a non-empty `--out`, so regenerate as `naryx` into a new directory
  (`--out /srv/naryx/release.next`, same `--data-dir`), then swap it in:
  `mv /srv/naryx/release /srv/naryx/release.prev && mv /srv/naryx/release.next /srv/naryx/release`,
  and restart. The data directory is untouched; keep `release.prev` until the restart is healthy.
- Cross-domain recovery has its own unit, `naryx-cross-domain.service`, and never reuses the
  ordinary solver's signing wallet. Deploy and activate the isolated testnet cohort with
  `deployments/tools/deploy-evm-recovery.mjs`; generate its configuration using
  `deployments/tools/configure-evm-recovery.mjs`. The latter reads both chains, verifies active
  policies and deployed code hashes, and writes runtime configuration plus observations outside
  the checkout. See the recovery section in `deployments/tools/README.md` for operator inputs.
  Install the runtime at `/srv/naryx/release/recovery/cross-domain-runtime.json`, its two dedicated
  keys at the paths it specifies, and `env/cross-domain.env` with the enable flag, configuration
  path and the two testnet RPC variables. Files are owned by `naryx` with mode 600. Preserve
  `/srv/naryx/data/cross-domain` across restarts and releases; it contains account fences and
  pending submissions, not disposable cache. Enable only `naryx-cross-domain` after installation.
  On 2026-10-18 both delayed policy sets were activated and this worker started with no queued
  jobs. The entry cap is 10 mock USDC per chain, not a claim that those accounts hold quote funds.
  Existing API, solver and keeper processes were not restarted. Both conformance-oracle timers
  were restored after deployment. To disable new admission, stop the worker and preserve every
  journal; inspect pending transactions and positions before any rollback. Stopping a worker
  does not reverse a committed trade or cancel an already-broadcast transaction.
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
