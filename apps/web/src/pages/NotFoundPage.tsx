import { useLocation } from 'react-router';
import { useAuth } from '../auth/auth-context';
import { AppShell } from '../components/AppShell';
import { AuthLayout } from '../components/AuthLayout';
import { ErrorState } from '../components/ErrorState';
import { Spinner } from '../components/ui';

const MESSAGE =
  'The address may be mistyped, or the page may have moved. Nothing you have shared is affected.';

/**
 * Unknown web addresses. Signed-in people stay inside the app (with its navigation); visitors
 * see the public layout. It never signs anyone in or sends them to a member page they cannot
 * open: the way out is Home for members and the welcome page for visitors.
 *
 * The static host serves the app for every path (so refreshing a nested route works), which
 * means the HTTP status of this page is 200; the API itself answers unknown routes with 404.
 */
export function NotFoundPage() {
  const { state } = useAuth();
  const { pathname } = useLocation();
  if (state.status === 'loading') return <Spinner label="Loading" />;

  const path = (
    <p>
      <code>{pathname.length > 80 ? `${pathname.slice(0, 80)}…` : pathname}</code> isn’t a page in
      OGC.
    </p>
  );

  const pending =
    state.status === 'signed-in' && state.account.accountStatus === 'PENDING_VERIFICATION';
  if (state.status === 'signed-in' && !pending) {
    return (
      <AppShell title="Page not found" hideTitle>
        <ErrorState kind="not-found" title="Page not found">
          {path}
          <p>{MESSAGE}</p>
        </ErrorState>
      </AppShell>
    );
  }
  return (
    <AuthLayout title="Page not found" subtitle={MESSAGE}>
      <ErrorState
        kind="not-found"
        title="Page not found"
        heading="none"
        home={
          pending
            ? // Not verified yet: member pages would send them to /verify anyway.
              { to: '/verify', label: 'Finish verifying your email' }
            : { to: '/', label: 'Go to the welcome page' }
        }
      >
        {path}
      </ErrorState>
    </AuthLayout>
  );
}
