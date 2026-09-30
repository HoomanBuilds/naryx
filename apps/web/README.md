# apps/web

The Naryx web application: the public landing page at `/` and the package trading terminal at `/trade`, on the Next.js App Router.

```bash
npm run dev      # development server
npm run lint
npm run build
```

The web app talks to Naryx services over HTTP only. It holds no signing authority or service credentials; wallets sign in the browser through their own extensions.

## Configuration

| Variable | Effect |
|---|---|
| `NEXT_PUBLIC_PRIVATE_TERMINAL_API_BASE_URL` | The private terminal service for previews, order preparation, lifecycle, and receipts. Without it the terminal runs on the local conformance provider and says so. |
| `NEXT_PUBLIC_NARYX_PUBLIC_API_BASE_URL` | The public v1 market API. |
| `NEXT_PUBLIC_NARYX_PACKAGE_MARKET_ID` | The package market (execution class) the terminal shows from the public API. |

With both public API variables set, the terminal reads executable package depth and the observed package tape, then follows them over the public API WebSocket stream (`/v1/stream`), polling every few seconds only while the stream is down; rebuilds candles from observed trades only, and labels its market data `OBSERVED`. Leg prices are not public market data, so the spot and perpetual series say so rather than showing a model. Without the variables, or until the API first answers, market data stays on the deterministic fixture under its `FIXTURE` label and chart watermark. After a failed poll the last observed data stays on screen and the status bar marks the feed stale with the reason.

The terminal never presents fixture, modeled, or indicative values as executable market data, and it shows the public deployment and mainnet-write restrictions in its status bar.
