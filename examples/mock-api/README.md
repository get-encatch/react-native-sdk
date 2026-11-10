# Encatch mock API

A local stand-in for the Encatch gateway and core API, built on [Hono](https://hono.dev). The SDK tests and the example apps use it, so bursts, rate limits and error cases never touch dev, UAT or production. It never forwards anything to a real server.

What it copies from the real server, and from which source file, is listed in [CONTRACT.md](CONTRACT.md).

## Run it for the example apps

```bash
pnpm install --filter @encatch/mock-api
pnpm --filter @encatch/mock-api dev
```

It listens on `http://127.0.0.1:8787`.

- **Options:** `--preset <name>` (rate limits), `--port <n>` and `--host <addr>`.
- **Physical devices:** use `--host 0.0.0.0` only when you test on a physical device on your LAN.
- **Example app settings:**
  - API base URL: `http://localhost:8787`, or `http://10.0.2.2:8787` from the Android emulator.
  - `webHost` stays `https://form.dev.encatch.com`. The survey page is static and makes no API calls itself.
- **API keys:**

  | Key | Secure mode |
  |---|---|
  | `mock-api-key` | Off |
  | `mock-secure-api-key` | Secret `mock-secret`, no session time |
  | `mock-secure-session-api-key` | Secret `mock-secret`, 15-minute session time |

- **Built-in forms:** `0190f1d2-0000-7000-8000-00000000f001` and `…f002`.

## Use it in tests (in-process, no port)

```ts
import { createMockApi } from '../examples/mock-api/src';

const mock = createMockApi({ preset: 'per-endpoint-5', scenario: { latencyMs: 0 } });
vi.stubGlobal('fetch', mock.fetch);

mock.update({ triggers: { screens: { '/checkout': { formId: '0190f1d2-0000-7000-8000-00000000f001' } } } });
// ... drive the SDK ...
expect(mock.requests('show-form')).toHaveLength(1);
```

## Control API

These routes sit under `/__mock/`, outside the Encatch API.

| Route | What it does |
|---|---|
| `GET /__mock/stats` | Request counts per endpoint and status |
| `GET /__mock/requests?endpoint=&limit=` | Request log, with headers (API key masked), body, status and duration |
| `GET /__mock/scenario` | The current scenario |
| `POST /__mock/scenario` | Changes the scenario, for example `{"preset":"planned-prod"}`, `{"latencyMs":200}`, `{"triggers":{"screens":{"/home":{"formId":"…","onPageDelay":2}}}}` or `{"faults":[{"endpoint":"track-event","count":1,"status":429,"retryAfterSeconds":10}]}` |
| `GET /__mock/sign?userName=&apiKey=` | Stands in for the customer's backend in secure mode: returns `{ signature }` for a secure key, plus the signed `time` for keys with a session time |
| `GET /__mock/hooks`, `POST /__mock/hooks` | The example app reports its `onRequest` / `onResponse` debug-hook calls here. Not part of the request log |
| `POST /__mock/reset` | Clears traffic and hook reports, and restores the starting scenario. Add `?keepScenario=1` to keep the scenario |

## Rate-limit presets

| Preset | Limits per minute |
|---|---|
| `off` | None (default) |
| `code-defaults-test` / `code-defaults-prod` | The gateway's defaults: one shared bucket per user, IP and project |
| `report` | 500 per endpoint |
| `per-endpoint-5` | 5 per endpoint |
| `planned-prod` | identify 5 per user name, track-screen 20, track-event 5, show-form and submit-form 100 |
| `tiny` | 5 shared per IP |

See [CONTRACT.md](CONTRACT.md) for details.
