# Naryx web

The Next.js application has a public website at `/` and a six-view trading terminal. It is the first-party client for the same package markets, quotes, lifecycle records, and receipts exposed by the Naryx services. It holds no solver key or service signing authority.

## Routes

| Route | What a user can do |
|---|---|
| `/` | Understand the product and open the terminal. |
| `/trade` | Select a domain and strategy market, inspect candles and package depth, prepare a bounded order, compare whole-package quotes, sign, and track entry or exit. |
| `/markets` | Search canonical strategy markets, inspect quote conventions and executable depth, and compare opportunities. |
| `/portfolio` | Inspect balances, positions, strategy accounts, risk domains, clearing, and scenario views. |
| `/activity` | Inspect submitted attempts, terminal outcomes, receipts, and evidence. |
| `/liquidity` | Inspect maker quote shards, solver capacity, and liquidity quality. |
| `/network` | Inspect domain readiness, settlement semantics, qualification, and recovery capacity. |

The terminal supports Solana Devnet, Base Sepolia, Arbitrum Sepolia, and Hyperliquid Testnet. A domain appears as executable only while its service reports an available runtime and execution-readiness gate. The UI does not promote a compiled or deployed module into an executable market on its own.

## User flow

1. Choose the network and a versioned strategy market. The market view shows the package's economics and the settlement class for that domain.
2. Enter size and bounded execution terms. The service prepares an unsigned action and quotes the entire strategy rather than just a leg price.
3. Review net outcome, cost, margin, expiry, fees, and recovery terms. Wallet signing happens in the user's browser.
4. Follow the attempt until its onchain or venue evidence supports a terminal state. Portfolio and Activity show the resulting position, exit, or unresolved recovery state.

The account and asset identifiers used for signing remain exact. The dense trading header and market table use short human-readable labels where the identity is known; the underlying identifier remains available for inspection.

### Funded cash markets

Markets and Portfolio also expose a separate funded cash-market panel. A connected EVM wallet can open its own clearing account, approve an exact test-USDC amount, deposit, request a buy/sell or full-exit quote, sign the match, and submit it on the selected Sepolia network. After closing, realized cash can be normalized into collateral before a flat-account withdrawal. Each funding or withdrawal action is capped at 100 test USDC. The panel simulates transactions before wallet submission and rechecks wallet identity and network.

Submitted transaction hashes are stored locally per API, house, and wallet. Actions remain blocked until transaction inclusion and account refresh. Multiple included trades can await finality together, so an exit does not wait for entry receipt finalization. The durable browser journal preserves every unfinalized transaction across refreshes. The panel automatically retries observation, never execution. Finality may take up to 20 minutes. Its trade history includes controlled owner-signed verification transactions and does not claim organic volume.

The initial ETH cash-range markets are bounded, fully collateralized cash instruments. They do not create routed spot/perpetual positions, options, cross-chain atomicity, or public package-book depth.

Registered standing-supplier variants additionally show live contract-derived bids, asks and funded capacity. Their pricing policy runs onchain through ERC-1271. These separate cash-range books do not imply that the external strategy books have funded maker liquidity. Capacity is conditional on the account state at acceptance and is never labeled an exclusive inventory reservation.

### SOL cash-and-carry maker quotes

Selecting cash and carry on Solana shows live maker pricing at up to five alternative sizes per side. The AWS API reads finalized standing levels, available inventory and venue pricing through `/internal/terminal/solana-devnet/quote-ladder`. The terminal refreshes every five seconds while visible and removes failed or ten-second-old observations. Entry quotes disappear when the perpetual market pauses opens; supported exits remain separate.

These are indicative, inventory-backed size alternatives, not additive resting depth. Basis is spot value minus perpetual notional for the complete size; perpetual fees are shown separately, excluding funding and gas. Clicking a row only updates the entry or exit ticket. A fresh, wallet-specific firm quote is still required before reservation and execution. Treasury hedges and other strategy books never reuse this liquidity.

## Data and trust boundaries

`src/features/terminal/shell/` owns the shared header, selected domain, service health, wallet context, and transaction watch. `pages/` owns the six terminal views. `pro/` owns the chart, depth, ticket-side widgets, and market bar. `private-http-terminal-provider.ts` talks to the private terminal API; `public-market-feed.ts` uses the public v1 API and stream.

| Label | Meaning in the terminal |
|---|---|
| `EXECUTABLE` | A current qualified quote or book level that the relevant execution path can attempt under its stated limits. |
| `OBSERVED` | A market trade, position, receipt, or other past event reported by a source. It is not an executable price. |
| `INDICATIVE` or `MODELED` | An estimate, scenario, or preview; it cannot by itself settle a transaction. |
| `FIXTURE` | Local deterministic presentation data when the service is not configured. It is not testnet liquidity. |

The chart supports OHLC candles, volume, moving averages, and basis, spot, or perpetual views when the underlying observations exist. The public feed loads package books and tape from the API, follows `/v1/stream`, and resynchronizes over HTTP. A signed market catalogue enriches listed markets only after its hash and Ed25519 signature verify against the configured public authority. Stale or unavailable data is labeled rather than silently replaced with a fabricated live price.

The app imports `@naryx/sdk` over its public client boundary. It does not import service internals, venue adapters, or contract source. Browser environment variables are public build inputs, never places for private keys.

## Configuration

Copy [`.env.example`](.env.example) to a local ignored `.env.local` and fill only the services you are running. Do not commit the result. The important variables are:

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_PRIVATE_TERMINAL_API_BASE_URL` | Private API origin for preparation, previews, lifecycle, and receipts. Required for testnet execution. |
| `NEXT_PUBLIC_NARYX_PUBLIC_API_BASE_URL` | Public v1 origin for package markets, books, tape, and streams. |
| `NEXT_PUBLIC_NARYX_PACKAGE_MARKET_ID` | Initial package market shown in the terminal. |
| `NEXT_PUBLIC_NARYX_CATALOGUE_AUTHORITY` and `NEXT_PUBLIC_NARYX_CATALOGUE_PUBLIC_KEY` | Pinned authority for signed market metadata. |
| `NEXT_PUBLIC_*_RPC_URL` and testnet quote token variables | Optional testnet wallet balance endpoints and quote-token identities, as enumerated in `.env.example`. |
| `NEXT_PUBLIC_SITE_URL` | Absolute URL for metadata, sitemap, and social previews. |

`NEXT_PUBLIC_*` values are compiled into the client bundle. Rebuild after changing them. With no API origin, the terminal uses a clearly labeled local conformance fixture and cannot execute a testnet package. With a configured API, service health and domain readiness govern action availability. The [testnet go-live guide](../../deployments/GO-LIVE.md) describes the generated production environment and host configuration.

## Local development

Use Node.js 22 and npm with the committed lockfile:

```bash
npm ci
npm run build:dependencies
npm run dev
```

Open `http://localhost:3000` for the website or `http://localhost:3000/trade` for the terminal. These commands run from `apps/web`. Focused static checks are:

```bash
npm run lint
npx tsc --noEmit
```

The release build is `npm run build`. Its `prebuild` step builds the local SDK and protocol dependencies. The deployment record is generated outside this app under [`deployments/`](../../deployments/README.md); the browser never reads a deployer or solver secret.

## Static hosting only

`next build` exports the complete site into `out/`. Vercel serves those files through its CDN; API calls, streams, signing preparation, and execution go directly to the AWS services. There are no Vercel API routes, Server Actions, request-time rendering, middleware, or scheduled functions. Image optimization is disabled, and robots and sitemap files are generated at build time. Do not introduce server-side runtime features into this workspace.

`vercel.json` preserves the security headers at the CDN level without invoking a function. Another static host must apply those same headers and resolve extensionless page URLs to their exported HTML files. `next start` is not compatible with static exports and is intentionally not offered as a script; use `npm run dev` for local development or serve `out/` with a static file server for release previews.

This deployment model avoids application Vercel Functions and their Fluid active CPU usage. CDN requests, bandwidth, and build usage are separate. Before promotion, inspect the deployment output and confirm no functions were generated. Existing deployments do not change until the static build is deployed and promoted.

## Scope of the current release

The interface exposes broad strategy construction and risk views, but each route's live capability depends on exact template, adapter, domain, market, and service activation. Test assets, test liquidity, and controlled walkthrough data must not be represented as organic trading activity. Mainnet write actions are disabled by repository policy.
