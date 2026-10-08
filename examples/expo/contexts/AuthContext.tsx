import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const AUTH_USER_KEY = 'encatch_auth_user';

interface AuthContextType {
  user: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (username: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    AsyncStorage.getItem(AUTH_USER_KEY).then((stored) => {
      setUser(stored);
      setIsLoading(false);
    });
  }, []);

  const login = useCallback(async (username: string) => {
    await AsyncStorage.setItem(AUTH_USER_KEY, username);
    setUser(username);
  }, []);

  const logout = useCallback(async () => {
    await AsyncStorage.removeItem(AUTH_USER_KEY);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        isLoading,
        login,
        logout,
      }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
