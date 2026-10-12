import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { Spinner } from '../components/ui';
import { useAuth } from './auth-context';

/** Only for signed-in users. Pending accounts are sent to the verification screen. */
export function RequireAccount({
  children,
  allowPending = false,
}: {
  children: ReactNode;
  allowPending?: boolean;
}) {
  const { state } = useAuth();
  if (state.status === 'loading') return <Spinner label="Loading your account" />;
  if (state.status === 'signed-out') return <Navigate to="/login" replace />;
  const pending = state.account.accountStatus === 'PENDING_VERIFICATION';
  if (pending && !allowPending) return <Navigate to="/verify" replace />;
  if (!pending && allowPending) return <Navigate to="/home" replace />;
  return children;
}

/** Only for visitors who are not signed in. */
export function GuestOnly({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  if (state.status === 'loading') return <Spinner label="Loading" />;
  if (state.status === 'signed-in') return <Navigate to="/home" replace />;
  return children;
}
