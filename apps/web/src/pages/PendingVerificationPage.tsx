import { useState } from 'react';
import { useAuth } from '../auth/auth-context';
import { AuthLayout } from '../components/AuthLayout';
import { Alert, Button } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage } from '../lib/form';
import styles from './forms.module.css';

/** Signed in, but the email address is not verified yet. */
export function PendingVerificationPage() {
  const { state, reload, logout } = useAuth();
  const [notice, setNotice] = useState<{ tone: 'success' | 'error' | 'info'; text: string }>();
  const [busy, setBusy] = useState<'resend' | 'check'>();
  const email = state.status === 'signed-in' ? state.account.email : '';

  async function resend() {
    setBusy('resend');
    try {
      const { message } = await api.resendVerification();
      setNotice({ tone: 'success', text: message });
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) });
    } finally {
      setBusy(undefined);
    }
  }

  async function check() {
    setBusy('check');
    try {
      await reload();
      setNotice({ tone: 'info', text: 'Your email is not verified yet.' });
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <AuthLayout
      title="Verify your email"
      subtitle="One last step before your OGC ID is active."
      footer={
        <Button variant="ghost" onClick={() => void logout()}>
          Sign out
        </Button>
      }
    >
      <div className={styles.stack}>
        <p className={styles.muted}>
          We sent a verification link to <span className={styles.strong}>{email}</span>. Open it on
          any device to activate your account.
        </p>
        {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
        <Button busy={busy === 'check'} onClick={() => void check()}>
          I have verified my email
        </Button>
        <Button variant="secondary" busy={busy === 'resend'} onClick={() => void resend()}>
          Send a new link
        </Button>
      </div>
    </AuthLayout>
  );
}
