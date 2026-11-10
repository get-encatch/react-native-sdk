import { Platform } from 'react-native';

export type EncatchEnvironment = 'mock' | 'dev' | 'uat' | 'prod';

export const ENCATCH_ENVIRONMENTS: readonly EncatchEnvironment[] = ['mock', 'dev', 'uat', 'prod'] as const;

export type EnvironmentEndpoints = {
  label: string;
  apiBaseUrl: string;
  webHost: string;
};

/**
 * The local mock API (examples/mock-api), started with
 * `pnpm --filter @encatch/mock-api dev`. The Android emulator reaches the host
 * machine at 10.0.2.2; a physical device needs the host's LAN address through
 * EXPO_PUBLIC_ENCATCH_MOCK_API_URL (and the mock started with --host 0.0.0.0).
 */
export const MOCK_API_URL =
  process.env.EXPO_PUBLIC_ENCATCH_MOCK_API_URL ??
  (Platform.OS === 'android' ? 'http://10.0.2.2:8787' : 'http://localhost:8787');

/** API keys the mock accepts (see examples/mock-api/README.md). */
export const MOCK_API_KEY = 'mock-api-key';
export const MOCK_FORM_ID = '0190f1d2-0000-7000-8000-00000000f001';

export const ENVIRONMENT_ENDPOINTS: Record<EncatchEnvironment, EnvironmentEndpoints> = {
  mock: {
    label: 'Mock (local)',
    apiBaseUrl: MOCK_API_URL,
    // The survey page is static and makes no API calls itself, so the dev host is fine.
    webHost: 'https://form.dev.encatch.com',
  },
  prod: {
    label: 'Production',
    apiBaseUrl: 'https://api.encatch.com',
    webHost: 'https://form.encatch.com',
  },
  dev: {
    label: 'Development',
    apiBaseUrl: 'https://api.dev.encatch.com',
    webHost: 'https://form.dev.encatch.com',
  },
  uat: {
    label: 'UAT',
    apiBaseUrl: 'https://api.uat.encatch.com',
    webHost: 'https://form-uat.encatch.com',
  },
};

export function resolveEnvironment(value?: string | null): EncatchEnvironment {
  if (value === 'mock' || value === 'dev' || value === 'uat' || value === 'prod') return value;
  return 'uat';
}

export function getEnvironmentEndpoints(env: EncatchEnvironment): EnvironmentEndpoints {
  return ENVIRONMENT_ENDPOINTS[env];
}
