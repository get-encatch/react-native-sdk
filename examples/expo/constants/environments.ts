export type EncatchEnvironment = 'dev' | 'uat' | 'prod';

export const ENCATCH_ENVIRONMENTS: readonly EncatchEnvironment[] = ['dev', 'uat', 'prod'] as const;

export type EnvironmentEndpoints = {
  label: string;
  apiBaseUrl: string;
  webHost: string;
};

export const ENVIRONMENT_ENDPOINTS: Record<EncatchEnvironment, EnvironmentEndpoints> = {
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
  if (value === 'dev' || value === 'uat' || value === 'prod') return value;
  return 'uat';
}

export function getEnvironmentEndpoints(env: EncatchEnvironment): EnvironmentEndpoints {
  return ENVIRONMENT_ENDPOINTS[env];
}
