import { loginRequestSchema } from '@ogc/validation';
import { useState } from 'react';
import { Text } from 'react-native';
import { useAuth } from '../auth/AuthProvider';
import { Button, Field, Notice } from '../components/ui';
import { errorMessage, fieldErrors } from '../lib/errors';
import { AuthScreen, text } from './Screen';

export function SignInScreen({
  onCreate,
  onBack,
  onForgot,
}: {
  onCreate: () => void;
  onBack?: () => void;
  onForgot?: () => void;
}) {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit() {
    setFormError(undefined);
    const parsed = loginRequestSchema.safeParse({ email, password });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await login(email, password);
    } catch (error) {
      setFormError(errorMessage(error));
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthScreen
      title="Welcome back"
      subtitle="Sign in to your OGC account."
      onBack={onBack}
      footer={
        <Text style={text.link} accessibilityRole="link" onPress={onCreate}>
          New to OGC? <Text style={text.strong}>Create your OGC ID</Text>
        </Text>
      }
    >
      {formError ? <Notice>{formError}</Notice> : null}
      <Field
        label="Email"
        icon="mail"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="username"
        returnKeyType="next"
        error={errors.email}
      />
      <Field
        label="Password"
        icon="lock"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
        error={errors.password}
      />
      <Button title="Sign in" busy={busy} onPress={() => void submit()} />
      {onForgot ? (
        <Text style={text.link} accessibilityRole="link" onPress={onForgot}>
          Forgot your password?
        </Text>
      ) : null}
    </AuthScreen>
  );
}
