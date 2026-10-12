import { useState } from 'react';
import { Text } from 'react-native';
import { useAuth } from '../auth/AuthProvider';
import { Button, Notice } from '../components/ui';
import { errorMessage } from '../lib/errors';
import { Screen, text } from './Screen';

export function CheckEmailScreen({ email, onSignIn }: { email: string; onSignIn: () => void }) {
  return (
    <Screen title="Check your email">
      <Text style={text.body}>
        If <Text style={text.strong}>{email}</Text> can be used for a new account, we have sent a
        verification link to it. Open the link to activate your OGC ID, then sign in.
      </Text>
      <Button title="Sign in" onPress={onSignIn} />
    </Screen>
  );
}

/** Signed in, but the email address is not verified yet. */
export function PendingVerificationScreen() {
  const { state, client, reload, logout } = useAuth();
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string }>();
  const [busy, setBusy] = useState<'resend' | 'check'>();
  const email = state.status === 'signed-in' ? state.account.email : '';

  async function run(kind: 'resend' | 'check', action: () => Promise<string>) {
    setBusy(kind);
    try {
      setNotice({ tone: 'success', text: await action() });
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) });
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Screen title="Verify your email" subtitle="One last step before your OGC ID is active.">
      <Text style={text.body}>
        We sent a verification link to <Text style={text.strong}>{email}</Text>.
      </Text>
      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
      <Button
        title="I have verified my email"
        busy={busy === 'check'}
        onPress={() =>
          void run('check', async () => {
            await reload();
            return 'Your email is not verified yet.';
          })
        }
      />
      <Button
        title="Send a new link"
        variant="secondary"
        busy={busy === 'resend'}
        onPress={() => void run('resend', async () => (await client.resendVerification()).message)}
      />
      <Button title="Sign out" variant="ghost" onPress={() => void logout()} />
    </Screen>
  );
}
