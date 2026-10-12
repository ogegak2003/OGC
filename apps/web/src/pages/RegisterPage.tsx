import { PASSWORD_MIN_LENGTH, registerRequestSchema } from '@ogc/validation';
import { type SyntheticEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { AuthLayout } from '../components/AuthLayout';
import { Alert, Button, PasswordField, TextField } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage, fieldErrors } from '../lib/form';
import styles from './forms.module.css';

export function RegisterPage() {
  const navigate = useNavigate();
  const [values, setValues] = useState({ displayName: '', email: '', password: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const update = (field: keyof typeof values) => (event: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [field]: event.target.value }));
  };

  async function onSubmit(event: SyntheticEvent) {
    event.preventDefault();
    setFormError(undefined);
    const parsed = registerRequestSchema.safeParse(values);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await api.register(values);
      void navigate('/check-email', { state: { email: parsed.data.email } });
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Create your OGC account"
      subtitle="You will receive a permanent OGC ID once you sign up."
      footer={
        <>
          Already have an OGC ID? <Link to="/login">Sign in</Link>
        </>
      }
    >
      <form className={styles.form} onSubmit={(e) => void onSubmit(e)} noValidate>
        {formError ? <Alert>{formError}</Alert> : null}
        <TextField
          label="Display name"
          name="displayName"
          autoComplete="name"
          value={values.displayName}
          onChange={update('displayName')}
          error={errors.displayName}
          hint="How people will see you. You can change it later."
        />
        <TextField
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          value={values.email}
          onChange={update('email')}
          error={errors.email}
          hint="Used to sign in and verify your account. Never shown to others."
        />
        <PasswordField
          label="Password"
          name="password"
          autoComplete="new-password"
          value={values.password}
          onChange={update('password')}
          error={errors.password}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters. A memorable phrase works well.`}
        />
        <Button type="submit" busy={busy}>
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}
