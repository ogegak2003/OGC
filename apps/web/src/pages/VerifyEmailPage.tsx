import { verifyEmailRequestSchema } from '@ogc/validation';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth/auth-context';
import { AuthLayout } from '../components/AuthLayout';
import { Alert, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage } from '../lib/form';
import styles from './forms.module.css';

type Status = { kind: 'verifying' } | { kind: 'verified' } | { kind: 'failed'; message: string };

function tokenFromHash(hash: string): string | undefined {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token') ?? '';
  return verifyEmailRequestSchema.safeParse({ token }).success ? token : undefined;
}

/**
 * Landing page of the emailed link (`/verify-email#token=…`). The token is
 * read from the URL fragment once, submitted once, then removed from the URL.
 */
export function VerifyEmailPage() {
  const { hash } = useLocation();
  const navigate = useNavigate();
  const { state, reload } = useAuth();
  const [token] = useState(() => tokenFromHash(hash));
  const [status, setStatus] = useState<Status>(() =>
    token
      ? { kind: 'verifying' }
      : { kind: 'failed', message: 'This verification link is incomplete or invalid.' },
  );
  const submitted = useRef(false);

  useEffect(() => {
    // Strip the secret from the address bar and browser history.
    void navigate('/verify-email', { replace: true });
    if (!token || submitted.current) return;
    submitted.current = true;
    api
      .verifyEmail(token)
      .then(async () => {
        setStatus({ kind: 'verified' });
        await reload().catch(() => undefined);
      })
      .catch((error: unknown) => {
        setStatus({ kind: 'failed', message: errorMessage(error) });
      });
  }, [token, navigate, reload]);

  if (status.kind === 'verifying') return <Spinner label="Verifying your email" />;

  const signedIn = state.status === 'signed-in';
  return (
    <AuthLayout title={status.kind === 'verified' ? 'Email verified' : 'Verification failed'}>
      <div className={styles.stack}>
        {status.kind === 'verified' ? (
          <>
            <Alert tone="success">Your OGC account is active.</Alert>
            <Link className={styles.linkButton} to={signedIn ? '/home' : '/login'}>
              {signedIn ? 'Go to my OGC ID' : 'Sign in'}
            </Link>
          </>
        ) : (
          <>
            <Alert>{status.message}</Alert>
            <p className={styles.muted}>Sign in to request a new verification link.</p>
            <Link className={styles.linkButton} to={signedIn ? '/verify' : '/login'}>
              {signedIn ? 'Request a new link' : 'Sign in'}
            </Link>
          </>
        )}
      </div>
    </AuthLayout>
  );
}
