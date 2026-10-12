import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
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
  const location = useLocation();
  if (state.status === 'loading') return <Spinner label="Loading your account" />;
  if (state.status === 'signed-out') {
    // Remember where the user was going (e.g. an OGC profile link) for after sign-in.
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
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
