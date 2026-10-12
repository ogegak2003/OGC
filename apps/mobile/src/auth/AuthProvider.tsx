import type { AccountView } from '@ogc/types';
import { type ReactNode, createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '../api/client';

export type AuthState =
  { status: 'loading' } | { status: 'signed-out' } | { status: 'signed-in'; account: AccountView };

interface AuthContextValue {
  state: AuthState;
  client: ApiClient;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    client.restore().then(
      (account) => {
        if (active) setState(account ? { status: 'signed-in', account } : { status: 'signed-out' });
      },
      () => {
        if (active) setState({ status: 'signed-out' });
      },
    );
    return () => {
      active = false;
    };
  }, [client]);

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      client,
      login: async (email, password) => {
        setState({ status: 'signed-in', account: await client.login(email, password) });
      },
      logout: async () => {
        try {
          await client.logout();
        } finally {
          setState({ status: 'signed-out' });
        }
      },
      reload: async () => {
        setState({ status: 'signed-in', account: await client.me() });
      },
    }),
    [state, client],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
