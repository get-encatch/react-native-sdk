import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import {
  clearStoredTesterSetup,
  emptyTesterSetup,
  persistTesterSetup,
  type TesterSetupValues,
} from '@/contexts/TesterConfigContext';

type TesterSessionContextValue = {
  setupValues: TesterSetupValues;
  isSdkReady: boolean;
  updateSetup: (values: TesterSetupValues) => Promise<void>;
  /** Clears saved setup and returns to the pre-login configuration screen. */
  changeSetup: () => Promise<void>;
};

const TesterSessionContext = createContext<TesterSessionContextValue | null>(null);

export function TesterSessionProvider({
  initialSetup,
  onSetupChange,
  children,
}: {
  initialSetup: TesterSetupValues;
  onSetupChange: (values: TesterSetupValues) => void;
  children: React.ReactNode;
}) {
  const [setupValues, setSetupValues] = useState(initialSetup);

  const updateSetup = useCallback(
    async (values: TesterSetupValues) => {
      await persistTesterSetup(values);
      setSetupValues(values);
      onSetupChange(values);
    },
    [onSetupChange]
  );

  const changeSetup = useCallback(async () => {
    await clearStoredTesterSetup();
    const next = emptyTesterSetup();
    setSetupValues(next);
    onSetupChange(next);
  }, [onSetupChange]);

  const value = useMemo(
    () => ({
      setupValues,
      isSdkReady: setupValues.apiKey.trim().length > 0,
      updateSetup,
      changeSetup,
    }),
    [changeSetup, setupValues, updateSetup]
  );

  return <TesterSessionContext.Provider value={value}>{children}</TesterSessionContext.Provider>;
}

export function useTesterSession() {
  const ctx = useContext(TesterSessionContext);
  if (!ctx) {
    throw new Error('useTesterSession must be used within TesterSessionProvider');
  }
  return ctx;
}
