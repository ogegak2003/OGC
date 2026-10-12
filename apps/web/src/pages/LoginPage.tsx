import { loginRequestSchema } from '@ogc/validation';
import { type SyntheticEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useAuth } from '../auth/auth-context';
import { AuthLayout } from '../components/AuthLayout';
import { Alert, Button, PasswordField, TextField } from '../components/ui';
import { errorMessage, fieldErrors } from '../lib/form';
import styles from './forms.module.css';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [values, setValues] = useState({ email: '', password: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: SyntheticEvent) {
    event.preventDefault();
    setFormError(undefined);
    const parsed = loginRequestSchema.safeParse(values);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const account = await login(values);
      void navigate(account.accountStatus === 'PENDING_VERIFICATION' ? '/verify' : '/home', {
        replace: true,
      });
    } catch (error) {
      setFormError(errorMessage(error));
      setValues((v) => ({ ...v, password: '' }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Sign in to OGC"
      subtitle="Welcome back."
      footer={
        <>
          New to OGC? <Link to="/register">Create your OGC ID</Link>
        </>
      }
    >
      <form className={styles.form} onSubmit={(e) => void onSubmit(e)} noValidate>
        {formError ? <Alert>{formError}</Alert> : null}
        <TextField
          label="Email"
          name="email"
          type="email"
          autoComplete="username"
          inputMode="email"
          value={values.email}
          onChange={(e) => {
            setValues((v) => ({ ...v, email: e.target.value }));
          }}
          error={errors.email}
        />
        <PasswordField
          label="Password"
          name="password"
          autoComplete="current-password"
          value={values.password}
          onChange={(e) => {
            setValues((v) => ({ ...v, password: e.target.value }));
          }}
          error={errors.password}
        />
        <Button type="submit" busy={busy}>
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}
