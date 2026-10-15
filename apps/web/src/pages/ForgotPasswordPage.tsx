import { forgotPasswordRequestSchema } from '@ogc/validation';
import { type SyntheticEvent, useState } from 'react';
import { Link } from 'react-router';
import { AuthLayout } from '../components/AuthLayout';
import { Alert, Button, TextField } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage, fieldErrors } from '../lib/form';
import styles from './forms.module.css';

/**
 * "Forgot password": asks for a reset link. The server answers the same way whether or not
 * the address has an account, and so does this page.
 */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [sent, setSent] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: SyntheticEvent) {
    event.preventDefault();
    setFormError(undefined);
    const parsed = forgotPasswordRequestSchema.safeParse({ email });
    if (!parsed.success) {
      setError(fieldErrors(parsed.error).email);
      return;
    }
    setError(undefined);
    setBusy(true);
    try {
      setSent((await api.forgotPassword(parsed.data.email)).message);
    } catch (e) {
      setFormError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="We’ll email you a link to choose a new one."
      footer={
        <>
          Remembered it? <Link to="/login">Sign in</Link>
        </>
      }
    >
      {sent ? (
        <div className={styles.stack}>
          <Alert tone="success">{sent}</Alert>
          <p className={styles.muted}>
            Check your inbox and spam folder. If nothing arrives, check the address and try again in
            a few minutes.
          </p>
          <p className={styles.muted}>
            Resetting signs you out on every device. End-to-end encrypted messages stay only on the
            devices that already have them — a reset cannot bring them back to a device that signs
            out.
          </p>
        </div>
      ) : (
        <form className={styles.form} onSubmit={(e) => void onSubmit(e)} noValidate>
          {formError ? <Alert>{formError}</Alert> : null}
          <TextField
            label="Email"
            name="email"
            type="email"
            autoComplete="username"
            inputMode="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
            error={error}
          />
          <Button type="submit" busy={busy}>
            Send reset link
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
