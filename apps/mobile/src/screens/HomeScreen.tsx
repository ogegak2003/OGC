import { color, elevation, fontSize, fontWeight, radius, space } from '@ogc/ui';
import { formatOgcIdForDisplay } from '@ogc/validation';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../auth/AuthProvider';
import { Button } from '../components/ui';
import { Screen, text } from './Screen';

/**
 * Signed-in home: the OGC ID is the hero. A scannable QR code is planned for
 * mobile (requires an SVG renderer); the web app already shows it.
 */
export function HomeScreen() {
  const { state, logout } = useAuth();
  if (state.status !== 'signed-in') return null;
  const { account } = state;

  return (
    <Screen>
      <Text style={text.body}>Welcome, {account.displayName}</Text>
      <View style={styles.card}>
        <Text style={styles.label} accessibilityRole="header">
          YOUR OGC ID
        </Text>
        <Text style={styles.ogcId} accessibilityLabel={account.ogcId} selectable>
          {formatOgcIdForDisplay(account.ogcId)}
        </Text>
        <Text style={text.body}>
          Share your OGC ID so people can find you. Your email and phone number stay private.
        </Text>
      </View>
      <View style={styles.details}>
        <Text style={styles.detailLabel}>Email</Text>
        <Text style={styles.detailValue}>
          {account.email}
          {account.emailVerified ? '  ·  Verified' : ''}
        </Text>
      </View>
      <Button title="Sign out" variant="secondary" onPress={() => void logout()} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: space[3],
    padding: space[6],
    backgroundColor: color.surfaceRaised,
    borderColor: color.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.xl,
    boxShadow: elevation.medium,
  },
  label: {
    color: color.accent,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    letterSpacing: 2,
  },
  ogcId: {
    color: color.textPrimary,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    fontSize: fontSize['2xl'],
    fontWeight: fontWeight.medium,
    fontVariant: ['tabular-nums'],
    letterSpacing: 2,
  },
  details: { gap: space[1] },
  detailLabel: { color: color.textMuted, fontSize: fontSize.sm },
  detailValue: { color: color.textPrimary, fontSize: fontSize.md },
});
