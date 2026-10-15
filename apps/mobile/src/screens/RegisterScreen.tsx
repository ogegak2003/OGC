import { color, fontSize, space } from '@ogc/ui';
import { PASSWORD_MIN_LENGTH, registerRequestSchema } from '@ogc/validation';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../auth/AuthProvider';
import { Icon } from '../components/Icon';
import { Button, Field, Notice } from '../components/ui';
import { errorMessage, fieldErrors } from '../lib/errors';
import { AuthScreen, text } from './Screen';

export function RegisterScreen({
  onRegistered,
  onSignIn,
  onBack,
}: {
  onRegistered: (email: string) => void;
  onSignIn: () => void;
  onBack?: () => void;
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
    <AuthScreen
      title="Create your OGC account"
      subtitle="You will receive a permanent OGC ID once you sign up."
      onBack={onBack}
      footer={
        <Text style={text.link} accessibilityRole="link" onPress={onSignIn}>
          Already have an OGC ID? <Text style={text.strong}>Sign in</Text>
        </Text>
      }
    >
      {formError ? <Notice>{formError}</Notice> : null}
      <Field
        label="Display name"
        icon="user"
        value={values.displayName}
        onChangeText={set('displayName')}
        autoComplete="name"
        hint="How people see you. You can change it later."
        error={errors.displayName}
      />
      <Field
        label="Email"
        icon="mail"
        value={values.email}
        onChangeText={set('email')}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        hint="Private. Used to verify your account and sign in."
        error={errors.email}
      />
      <Field
        label="Password"
        icon="lock"
        value={values.password}
        onChangeText={set('password')}
        secureTextEntry
        autoComplete="new-password"
        textContentType="newPassword"
        placeholder={`At least ${String(PASSWORD_MIN_LENGTH)} characters`}
        error={errors.password}
      />
      <View style={styles.privacy}>
        <Icon name="shieldCheck" size={18} tint={color.accent} />
        <Text style={styles.privacyText}>
          Your phone number is never needed. Others find you only by your OGC ID.
        </Text>
      </View>
      <Button title="Create account" busy={busy} onPress={() => void submit()} />
    </AuthScreen>
  );
}

const styles = StyleSheet.create({
  privacy: { flexDirection: 'row', gap: space[2], alignItems: 'flex-start' },
  privacyText: { flex: 1, color: color.textMuted, fontSize: fontSize.sm, lineHeight: 20 },
});
