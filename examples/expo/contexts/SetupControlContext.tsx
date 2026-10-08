import React, { createContext, useContext } from 'react';

type SetupControlContextValue = {
  clearSavedSetup: () => Promise<void>;
};

const SetupControlContext = createContext<SetupControlContextValue | null>(null);

export function SetupControlProvider({
  clearSavedSetup,
  children,
}: {
  clearSavedSetup: () => Promise<void>;
  children: React.ReactNode;
}) {
  return (
    <SetupControlContext.Provider value={{ clearSavedSetup }}>{children}</SetupControlContext.Provider>
  );
}

export function useSetupControl() {
  const ctx = useContext(SetupControlContext);
  if (!ctx) {
    throw new Error('useSetupControl must be used within SetupControlProvider');
  }
  return ctx;
}
