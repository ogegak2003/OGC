import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { AuthContext, type AuthContextValue, type AuthState } from './auth-context';

/**
 * Holds the signed-in account. The session itself lives in HttpOnly cookies;
 * this state is only a cache of `GET /auth/me`.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  const reload = useCallback(async () => {
    try {
      setState({ status: 'signed-in', account: await api.me() });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setState({ status: 'signed-out' });
        return;
      }
      throw error;
    }
  }, []);

  // Resolve the initial session once on mount.
  useEffect(() => {
    const controller = new AbortController();
    api.me(controller.signal).then(
      (account) => {
        setState({ status: 'signed-in', account });
      },
      () => {
        if (!controller.signal.aborted) setState({ status: 'signed-out' });
      },
    );
    return () => {
      controller.abort();
    };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      reload,
      login: async (credentials) => {
        const { account } = await api.login(credentials);
        setState({ status: 'signed-in', account });
        return account;
      },
      logout: async () => {
        try {
          await api.logout();
        } finally {
          setState({ status: 'signed-out' });
        }
      },
    }),
    [state, reload],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}
