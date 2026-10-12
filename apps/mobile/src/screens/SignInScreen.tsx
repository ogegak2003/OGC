import { loginRequestSchema } from '@ogc/validation';
import { useState } from 'react';
import { Text } from 'react-native';
import { useAuth } from '../auth/AuthProvider';
import { Button, Field, Notice } from '../components/ui';
import { errorMessage, fieldErrors } from '../lib/errors';
import { Screen, text } from './Screen';

export function SignInScreen({ onCreate }: { onCreate: () => void }) {
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
    <Screen title="Sign in to OGC" subtitle="Welcome back.">
      {formError ? <Notice>{formError}</Notice> : null}
      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="username"
        error={errors.email}
      />
      <Field
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
        error={errors.password}
      />
      <Button title="Sign in" busy={busy} onPress={() => void submit()} />
      <Text style={text.link} accessibilityRole="link" onPress={onCreate}>
        New to OGC? Create your OGC ID
      </Text>
    </Screen>
  );
}
