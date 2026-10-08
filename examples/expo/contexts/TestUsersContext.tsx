import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { UserTraits } from '@encatch/react-native-sdk';

const STORAGE_KEY = 'encatch_tester_saved_users';

export type StoredTestUser = {
  username: string;
  email: string;
  displayName: string;
};

type TestUsersContextValue = {
  users: StoredTestUser[];
  isLoading: boolean;
  addUser: (user: StoredTestUser) => Promise<void>;
  updateUser: (username: string, patch: Pick<StoredTestUser, 'email' | 'displayName'>) => Promise<void>;
  removeUser: (username: string) => Promise<void>;
  getUser: (username: string) => StoredTestUser | undefined;
};

const TestUsersContext = createContext<TestUsersContextValue | null>(null);

function normalizeUser(user: StoredTestUser): StoredTestUser {
  return {
    username: user.username.trim(),
    email: user.email.trim(),
    displayName: user.displayName.trim(),
  };
}

export function splitDisplayName(displayName: string): { firstName: string; lastName: string } {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

export function buildIdentifyTraits(user: Pick<StoredTestUser, 'email' | 'displayName'>): UserTraits | undefined {
  const $set: Record<string, string> = {};
  if (user.email.trim()) $set.email = user.email.trim();
  if (user.displayName.trim()) $set.display_name = user.displayName.trim();
  return Object.keys($set).length > 0 ? { $set } : undefined;
}

export function TestUsersProvider({ children }: { children: React.ReactNode }) {
  const [users, setUsers] = useState<StoredTestUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as StoredTestUser[];
          if (Array.isArray(parsed)) {
            setUsers(parsed.map(normalizeUser).filter((u) => u.username.length > 0));
          }
        } catch {
          /* ignore corrupt storage */
        }
      }
      setIsLoading(false);
    });
  }, []);

  const addUser = useCallback(async (user: StoredTestUser) => {
    const normalized = normalizeUser(user);
    if (!normalized.username) return;
    setUsers((prev) => {
      const without = prev.filter((u) => u.username !== normalized.username);
      const next = [...without, normalized];
      void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const updateUser = useCallback(
    async (username: string, patch: Pick<StoredTestUser, 'email' | 'displayName'>) => {
      setUsers((prev) => {
        const next = prev.map((u) =>
          u.username === username
            ? normalizeUser({ ...u, email: patch.email, displayName: patch.displayName })
            : u
        );
        void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        return next;
      });
    },
    []
  );

  const removeUser = useCallback(
    async (username: string) => {
      setUsers((prev) => {
        const next = prev.filter((u) => u.username !== username);
        void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        return next;
      });
    },
    []
  );

  const getUser = useCallback((username: string) => users.find((u) => u.username === username), [users]);

  const value = useMemo(
    () => ({ users, isLoading, addUser, updateUser, removeUser, getUser }),
    [users, isLoading, addUser, updateUser, removeUser, getUser]
  );

  return <TestUsersContext.Provider value={value}>{children}</TestUsersContext.Provider>;
}

export function useTestUsers() {
  const ctx = useContext(TestUsersContext);
  if (!ctx) {
    throw new Error('useTestUsers must be used within TestUsersProvider');
  }
  return ctx;
}
