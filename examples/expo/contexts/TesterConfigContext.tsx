import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { EncatchConfig } from '@/constants/Config';
import {
  type EncatchEnvironment,
  resolveEnvironment,
} from '@/constants/environments';
import { parseFormIds } from '@/constants/formIds';

const STORAGE_KEY_API_KEY = 'encatch_tester_api_key';
const STORAGE_KEY_FORM_ID = 'encatch_tester_form_id';
const STORAGE_KEY_INTERCEPTOR_FORM_ID = 'encatch_tester_interceptor_form_id';
const STORAGE_KEY_ENVIRONMENT = 'encatch_tester_environment';

export type TesterSetupValues = {
  apiKey: string;
  formId: string;
  interceptorFormId: string;
  environment: EncatchEnvironment;
};

export const emptyTesterSetup = (): TesterSetupValues => ({
  apiKey: '',
  formId: '',
  interceptorFormId: '',
  environment: 'uat',
});

type TesterConfigContextValue = {
  formId: string;
  interceptorFormId: string;
  envFormIds: readonly string[];
  setFormId: (formId: string) => void;
  setInterceptorFormId: (formId: string) => void;
};

const TesterConfigContext = createContext<TesterConfigContextValue | null>(null);

export function TesterConfigProvider({
  initialFormId,
  initialInterceptorFormId,
  children,
}: {
  initialFormId: string;
  initialInterceptorFormId: string;
  children: React.ReactNode;
}) {
  const [formId, setFormIdState] = useState(initialFormId);
  const [interceptorFormId, setInterceptorFormIdState] = useState(initialInterceptorFormId);

  const setFormId = useCallback((next: string) => {
    const trimmed = next.trim();
    setFormIdState(trimmed);
    void AsyncStorage.setItem(STORAGE_KEY_FORM_ID, trimmed);
  }, []);

  const setInterceptorFormId = useCallback((next: string) => {
    const trimmed = next.trim();
    setInterceptorFormIdState(trimmed);
    void AsyncStorage.setItem(STORAGE_KEY_INTERCEPTOR_FORM_ID, trimmed);
  }, []);

  const value = useMemo(
    () => ({
      formId,
      interceptorFormId,
      envFormIds: EncatchConfig.formIds,
      setFormId,
      setInterceptorFormId,
    }),
    [formId, interceptorFormId, setFormId, setInterceptorFormId]
  );

  return <TesterConfigContext.Provider value={value}>{children}</TesterConfigContext.Provider>;
}

export function useTesterConfig() {
  const ctx = useContext(TesterConfigContext);
  if (!ctx) {
    throw new Error('useTesterConfig must be used within TesterConfigProvider');
  }
  return ctx;
}

export async function loadStoredTesterSetup(): Promise<TesterSetupValues> {
  const [storedApiKey, storedFormId, storedInterceptorFormId, storedEnvironment] =
    await Promise.all([
      AsyncStorage.getItem(STORAGE_KEY_API_KEY),
      AsyncStorage.getItem(STORAGE_KEY_FORM_ID),
      AsyncStorage.getItem(STORAGE_KEY_INTERCEPTOR_FORM_ID),
      AsyncStorage.getItem(STORAGE_KEY_ENVIRONMENT),
    ]);

  return {
    apiKey: storedApiKey?.trim() ?? '',
    formId: storedFormId?.trim() ?? '',
    interceptorFormId: storedInterceptorFormId?.trim() ?? '',
    environment: resolveEnvironment(storedEnvironment),
  };
}

export async function persistTesterSetup(values: TesterSetupValues): Promise<void> {
  await Promise.all([
    AsyncStorage.setItem(STORAGE_KEY_API_KEY, values.apiKey.trim()),
    AsyncStorage.setItem(STORAGE_KEY_FORM_ID, values.formId.trim()),
    AsyncStorage.setItem(STORAGE_KEY_INTERCEPTOR_FORM_ID, values.interceptorFormId.trim()),
    AsyncStorage.setItem(STORAGE_KEY_ENVIRONMENT, values.environment),
  ]);
}

export async function clearStoredTesterSetup(): Promise<void> {
  await Promise.all([
    AsyncStorage.removeItem(STORAGE_KEY_API_KEY),
    AsyncStorage.removeItem(STORAGE_KEY_FORM_ID),
    AsyncStorage.removeItem(STORAGE_KEY_INTERCEPTOR_FORM_ID),
    AsyncStorage.removeItem(STORAGE_KEY_ENVIRONMENT),
  ]);
}

export function mergeEnvFormIds(formId: string): string[] {
  return parseFormIds([formId, ...EncatchConfig.formIds].filter(Boolean).join(','));
}
