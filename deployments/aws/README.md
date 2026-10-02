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

Run the release generator on the host with `--out /srv/naryx/release --data-dir /srv/naryx/data`
(`deployments/tools/README.md`, environment from `deployments/.env.example`). Set the API's
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
- Environment variables (Production): the values from the generated `web/.env.production`.
  `NEXT_PUBLIC_*` values are compiled in at build time, so redeploy after changing any.
- `NEXT_PUBLIC_PRIVATE_TERMINAL_API_BASE_URL` is `https://api.<your domain>`.

## 7. Operating

- Health: `curl https://api.<your domain>/internal/healthz`; point an uptime monitor (for example a
  Route 53 health check) at it.
- Deploy a new commit: `git pull`, `deployments/aws/build.sh`, regenerate the release if any
  template or deployment changed, then `sudo systemctl restart naryx-api naryx-solver naryx-keeper`.
- Restore: stop the services, copy a snapshot from S3 into `/srv/naryx/data` (same relative paths),
  start the services.
- Fund the solver, keeper, and Hyperliquid accounts before they run dry; their balances bound how
  many users can trade at once.
