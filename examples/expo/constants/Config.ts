/**
 * Encatch SDK configuration from environment variables.
 * Set these in .env (copy from .env.example).
 */
import { DEFAULT_API_BASE_URL, DEFAULT_WEB_HOST } from '@encatch/react-native-sdk';
import { parseFormIds } from './formIds';

const formIds = parseFormIds(process.env.EXPO_PUBLIC_ENCATCH_FORM_ID ?? '');

export const EncatchConfig = {
  apiKey: process.env.EXPO_PUBLIC_ENCATCH_API_KEY ?? '',
  /** Comma-separated EXPO_PUBLIC_ENCATCH_FORM_ID values, parsed and deduped. */
  formIds,
  /** First configured form id — default for exact inline slot. */
  formId: formIds[0] ?? '',
  apiBaseUrl: process.env.EXPO_PUBLIC_ENCATCH_API_BASE_URL ?? DEFAULT_API_BASE_URL,
  webHost: process.env.EXPO_PUBLIC_ENCATCH_WEB_HOST ?? DEFAULT_WEB_HOST,
};
