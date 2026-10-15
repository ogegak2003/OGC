import { forgotPasswordRequestSchema, newPasswordSchema, resetTokenFrom } from '@ogc/validation';
import { useState } from 'react';
import { Text } from 'react-native';
import { useAuth } from '../auth/AuthProvider';
import { Button, Field, Notice } from '../components/ui';
import { errorMessage, fieldErrors } from '../lib/errors';
import { AuthScreen, text } from './Screen';

type Step = 'request' | 'sent' | 'reset' | 'done';

/**
 * Password recovery on the phone: ask for a link by email, then paste that link (or open it
 * on any computer) and choose a new password. The answer to "send me a link" is the same
 * whether or not the address has an account.
 */
export function ForgotPasswordScreen({ onSignIn }: { onSignIn: () => void }) {
  const { client } = useAuth();
  const [step, setStep] = useState<Step>('request');
  const [email, setEmail] = useState('');
  const [link, setLink] = useState('');
  const [password, setPassword] = useState('');
  const [sentMessage, setSentMessage] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function request() {
    setFormError(undefined);
    const parsed = forgotPasswordRequestSchema.safeParse({ email });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      setSentMessage((await client.forgotPassword(parsed.data.email)).message);
      setStep('sent');
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setFormError(undefined);
    const token = resetTokenFrom(link);
    const next: Record<string, string> = {};
    if (!token) next.link = 'Paste the whole link from the email';
    const parsedPassword = newPasswordSchema.safeParse(password);
    if (!parsedPassword.success) next.password = fieldErrors(parsedPassword.error).form ?? '';
    if (!token || !parsedPassword.success) {
      setErrors(next);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await client.resetPassword({ token, newPassword: password });
      setPassword('');
      setLink('');
      setStep('done');
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const backToSignIn = (
    <Text style={text.link} accessibilityRole="link" onPress={onSignIn}>
      Back to <Text style={text.strong}>Sign in</Text>
    </Text>
  );

  if (step === 'done') {
    return (
      <AuthScreen title="Password changed" footer={backToSignIn}>
        <Notice tone="success">Your password was changed and every device was signed out.</Notice>
        <Text style={text.body}>
          Sign in again with your new password. A device that was signed out sets up encryption
          again, and messages sent before that are not available on it.
        </Text>
        <Button title="Sign in" onPress={onSignIn} />
      </AuthScreen>
    );
  }

  if (step === 'reset') {
    return (
      <AuthScreen
        title="Choose a new password"
        subtitle="Paste the link from the email, then pick a new password."
        onBack={() => {
          setStep('sent');
        }}
        footer={backToSignIn}
      >
        {formError ? <Notice>{formError}</Notice> : null}
        <Field
          label="Reset link"
          icon="link"
          value={link}
          onChangeText={setLink}
          autoCapitalize="none"
          autoCorrect={false}
          error={errors.link}
        />
        <Field
          label="New password"
          icon="lock"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="new-password"
          textContentType="newPassword"
          error={errors.password}
        />
        <Text style={text.muted}>
          This signs you out on every device. OGC does not store your end-to-end encrypted messages,
          so a reset cannot restore them to a device that is signed out.
        </Text>
        <Button title="Change password" busy={busy} onPress={() => void reset()} />
      </AuthScreen>
    );
  }

  if (step === 'sent') {
    return (
      <AuthScreen
        title="Check your email"
        onBack={() => {
          setStep('request');
        }}
        footer={backToSignIn}
      >
        <Notice tone="success">{sentMessage}</Notice>
        <Text style={text.body}>
          Open the link on this phone or any computer. If it opens in a browser on this phone, you
          can also copy it and paste it here.
        </Text>
        <Button
          title="I have the link"
          variant="secondary"
          onPress={() => {
            setStep('reset');
          }}
        />
      </AuthScreen>
    );
  }

  return (
    <AuthScreen
      title="Reset your password"
      subtitle="We’ll email you a link to choose a new one."
      onBack={onSignIn}
      footer={backToSignIn}
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
        error={errors.email}
      />
      <Button title="Send reset link" busy={busy} onPress={() => void request()} />
    </AuthScreen>
  );
}
