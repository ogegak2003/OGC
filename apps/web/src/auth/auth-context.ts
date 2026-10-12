import type { AccountView } from '@ogc/types';
import type { LoginRequest } from '@ogc/validation';
import { createContext, useContext } from 'react';

export type AuthState =
  { status: 'loading' } | { status: 'signed-out' } | { status: 'signed-in'; account: AccountView };

export interface AuthContextValue {
  state: AuthState;
  login: (credentials: Omit<LoginRequest, 'device'>) => Promise<AccountView>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
