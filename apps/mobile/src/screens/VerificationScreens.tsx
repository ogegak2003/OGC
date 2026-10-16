import { fontSize, fontWeight, radius, space } from '@ogc/ui';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../auth/AuthProvider';
import { Icon, type IconName } from '../components/Icon';
import { Button, Notice } from '../components/ui';
import { errorMessage } from '../lib/errors';
import { AuthScreen, text } from './Screen';
import { color, themedStyles } from '../theme';

function Badge({ icon }: { icon: IconName }) {
  return (
    <View style={styles.badge}>
      <Icon name={icon} size={30} tint={color.accent} />
    </View>
  );
}

function Steps({ steps }: { steps: string[] }) {
  return (
    <View style={styles.steps}>
      {steps.map((step, index) => (
        <View key={step} style={styles.step}>
          <View style={styles.stepNumber}>
            <Text style={styles.stepNumberText}>{index + 1}</Text>
          </View>
          <Text style={styles.stepText}>{step}</Text>
        </View>
      ))}
    </View>
  );
}

export function CheckEmailScreen({ email, onSignIn }: { email: string; onSignIn: () => void }) {
  return (
    <AuthScreen>
      <Badge icon="mail" />
      <Text style={styles.title} accessibilityRole="header">
        Check your email
      </Text>
      <Text style={text.body}>
        If <Text style={text.strong}>{email}</Text> can be used for a new account, we have sent a
        verification link to it. Open the link to activate your OGC ID, then sign in.
      </Text>
      <Steps
        steps={[
          'Open the email from OGC (check spam if it is not there).',
          'Tap the verification link.',
          'Come back and sign in.',
        ]}
      />
      <Button title="Sign in" onPress={onSignIn} />
    </AuthScreen>
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
    <AuthScreen>
      <Badge icon="mail" />
      <Text style={styles.title} accessibilityRole="header">
        Verify your email
      </Text>
      <Text style={text.body}>One last step before your OGC ID is active.</Text>
      <Text style={text.body}>
        We sent a verification link to <Text style={text.strong}>{email}</Text>.
      </Text>
      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
      <View style={styles.actions}>
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
          icon="refresh"
          busy={busy === 'resend'}
          onPress={() =>
            void run('resend', async () => (await client.resendVerification()).message)
          }
        />
        <Button title="Sign out" variant="ghost" icon="logout" onPress={() => void logout()} />
      </View>
    </AuthScreen>
  );
}

const styles = themedStyles(() =>
  StyleSheet.create({
    badge: {
      width: 64,
      height: 64,
      marginTop: space[6],
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: color.accentSubtle,
      borderColor: color.accentBorder,
      borderWidth: 1,
      borderRadius: radius.xl,
    },
    title: {
      color: color.textPrimary,
      fontSize: fontSize['2xl'],
      fontWeight: fontWeight.bold,
      letterSpacing: -0.4,
    },
    steps: {
      gap: space[3],
      padding: space[4],
      backgroundColor: color.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: color.border,
    },
    step: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
    stepNumber: {
      width: 26,
      height: 26,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 13,
      backgroundColor: color.surfaceHover,
    },
    stepNumberText: {
      color: color.accentHighlight,
      fontSize: fontSize.xs,
      fontWeight: fontWeight.bold,
    },
    stepText: { flex: 1, color: color.textSecondary, fontSize: fontSize.sm, lineHeight: 20 },
    actions: { gap: space[3] },
  }),
);
