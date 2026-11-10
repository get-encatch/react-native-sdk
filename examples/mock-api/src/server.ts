/**
 * Runs the mock on a local port for the example apps.
 *
 *   pnpm --filter @encatch/mock-api dev                      # 127.0.0.1:8787
 *   pnpm --filter @encatch/mock-api dev -- --preset per-endpoint-5
 *   pnpm --filter @encatch/mock-api dev -- --host 0.0.0.0   # physical device on the LAN
 *
 * It never forwards anything to a real Encatch server.
 */
import { serve } from '@hono/node-server';
import { createMockApi, DROP_STATUS } from './app';
import { RATE_LIMIT_PRESETS, type RateLimitPreset } from './scenario';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const port = Number(arg('port') ?? process.env.MOCK_API_PORT ?? 8787);
const hostname = arg('host') ?? process.env.MOCK_API_HOST ?? '127.0.0.1';
const preset = arg('preset') as RateLimitPreset | undefined;
if (preset && !(preset in RATE_LIMIT_PRESETS)) {
  console.error(`Unknown preset "${preset}". Use one of: ${Object.keys(RATE_LIMIT_PRESETS).join(', ')}`);
  process.exit(1);
}

const mock = createMockApi({ preset });

serve({
  hostname,
  port,
  fetch: async (req, env) => {
    const res = await mock.app.fetch(req, env);
    if (res.status === DROP_STATUS) {
      // Simulated network failure: close the socket without a response.
      const incoming = (env as any)?.incoming;
      incoming?.socket?.destroy();
      return new Response(null, { status: 502 });
    }
    return res;
  },
});

console.log(`Encatch mock API on http://${hostname}:${port}  (rate limits: ${preset ?? 'off'})`);
console.log(`  API:     http://${hostname}:${port}/engage-product/encatch/api/v2/encatch/<endpoint>`);
console.log(`  Control: http://${hostname}:${port}/__mock/{stats,requests,scenario,reset}`);
console.log(`  API keys: mock-api-key, mock-secure-api-key, mock-secure-session-api-key (secret: mock-secret)`);
