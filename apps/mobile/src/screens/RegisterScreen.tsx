import { PASSWORD_MIN_LENGTH, registerRequestSchema } from '@ogc/validation';
import { useState } from 'react';
import { Text } from 'react-native';
import { useAuth } from '../auth/AuthProvider';
import { Button, Field, Notice } from '../components/ui';
import { errorMessage, fieldErrors } from '../lib/errors';
import { Screen, text } from './Screen';

export function RegisterScreen({
  onRegistered,
  onSignIn,
}: {
  onRegistered: (email: string) => void;
  onSignIn: () => void;
}) {
  const { client } = useAuth();
  const [values, setValues] = useState({ displayName: '', email: '', password: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const set = (field: keyof typeof values) => (value: string) => {
    setValues((v) => ({ ...v, [field]: value }));
  };

  async function submit() {
    setFormError(undefined);
    const parsed = registerRequestSchema.safeParse(values);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await client.register(values);
      onRegistered(parsed.data.email);
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      title="Create your OGC account"
      subtitle="You will receive a permanent OGC ID once you sign up."
    >
      {formError ? <Notice>{formError}</Notice> : null}
      <Field
        label="Display name"
        value={values.displayName}
        onChangeText={set('displayName')}
        autoComplete="name"
        error={errors.displayName}
      />
      <Field
        label="Email"
        value={values.email}
        onChangeText={set('email')}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        error={errors.email}
      />
      <Field
        label="Password"
        value={values.password}
        onChangeText={set('password')}
        secureTextEntry
        autoComplete="new-password"
        textContentType="newPassword"
        placeholder={`At least ${PASSWORD_MIN_LENGTH} characters`}
        error={errors.password}
      />
      <Button title="Create account" busy={busy} onPress={() => void submit()} />
      <Text style={text.link} accessibilityRole="link" onPress={onSignIn}>
        Already have an OGC ID? Sign in
      </Text>
    </Screen>
  );
}
