import { PASSWORD_RESET_TOKEN, resetPasswordRequestSchema } from '@ogc/validation';
import { type SyntheticEvent, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth/auth-context';
import { AuthLayout } from '../components/AuthLayout';
import { Alert, Button, PasswordField } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage, fieldErrors } from '../lib/form';
import styles from './forms.module.css';

function tokenFromHash(hash: string): string | undefined {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token') ?? '';
  return PASSWORD_RESET_TOKEN.test(token) ? token : undefined;
}

/**
 * Landing page of the emailed link (`/reset-password#token=…`). The token is read from the
 * URL fragment once and immediately removed from the address bar and history; it is only
 * sent when the person submits a new password.
 */
export function ResetPasswordPage() {
  const { hash } = useLocation();
  const navigate = useNavigate();
  const { reload } = useAuth();
  const [token] = useState(() => tokenFromHash(hash));
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void navigate('/reset-password', { replace: true });
  }, [navigate]);

  async function onSubmit(event: SyntheticEvent) {
    event.preventDefault();
    if (!token) return;
    setFormError(undefined);
    const parsed = resetPasswordRequestSchema.safeParse({ token, newPassword: password });
    if (!parsed.success) {
      setError(fieldErrors(parsed.error).newPassword);
      return;
    }
    setError(undefined);
    setBusy(true);
    try {
      await api.resetPassword({ token, newPassword: password });
      setPassword('');
      setDone(true);
      // Every session ended, this browser's included.
      await reload().catch(() => undefined);
    } catch (e) {
      setFormError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <AuthLayout title="Reset link not valid">
        <div className={styles.stack}>
          <Alert>This reset link is incomplete or invalid.</Alert>
          <Link className={styles.linkButton} to="/forgot-password">
            Ask for a new link
          </Link>
        </div>
      </AuthLayout>
    );
  }

  if (done) {
    return (
      <AuthLayout title="Password changed">
        <div className={styles.stack}>
          <Alert tone="success">Your password was changed and every device was signed out.</Alert>
          <p className={styles.muted}>
            Sign in again on each device. Devices that were signed out need to set up encryption
            again, and messages sent before that are not available on them.
          </p>
          <Link className={styles.linkButton} to="/login">
            Sign in
          </Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Choose a new password"
      subtitle="At least 12 characters; a few unrelated words work well."
    >
      <form className={styles.form} onSubmit={(e) => void onSubmit(e)} noValidate>
        {formError ? (
          <Alert>
            {formError} <Link to="/forgot-password">Ask for a new link</Link>
          </Alert>
        ) : null}
        <PasswordField
          label="New password"
          name="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
          }}
          error={error}
        />
        <p className={styles.muted}>
          This signs you out on every device. Your end-to-end encrypted messages are not stored by
          OGC, so a reset cannot restore them to a device that is signed out.
        </p>
        <Button type="submit" busy={busy}>
          Change password
        </Button>
      </form>
    </AuthLayout>
  );
}
