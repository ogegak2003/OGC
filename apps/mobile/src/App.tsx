import { color, fontSize, fontWeight, letterSpacing, radius, space } from '@ogc/ui';
import { formatOgcId } from '@ogc/validation';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

/** Phase 0 shell: brand foundation rendered entirely from shared design tokens. */
export function App() {
  return (
    <View style={styles.screen}>
      <View style={styles.card}>
        <View style={styles.mark} accessible={false} />
        <Text style={styles.title} accessibilityRole="header">
          OGC
        </Text>
        <Text style={styles.subtitle}>ObagaGlobal Communication</Text>
        <Text style={styles.identity} accessibilityLabel="Example OGC identity">
          {formatOgcId(1)}
        </Text>
      </View>
      <Text style={styles.footer}>PLATFORM FOUNDATION · PHASE 0</Text>
      <StatusBar style="light" />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[6],
    padding: space[6],
    backgroundColor: color.background,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    alignItems: 'center',
    gap: space[2],
    paddingVertical: space[10],
    paddingHorizontal: space[8],
    backgroundColor: color.surface,
    borderColor: color.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.xl,
  },
  mark: {
    width: 56,
    height: 56,
    marginBottom: space[3],
    borderWidth: 4,
    borderColor: color.accent,
    borderRadius: radius.full,
  },
  title: {
    color: color.textPrimary,
    fontSize: fontSize['4xl'],
    fontWeight: fontWeight.semibold,
    letterSpacing: fontSize['4xl'] * 0.18,
  },
  subtitle: {
    color: color.textSecondary,
    fontSize: fontSize.sm,
  },
  identity: {
    marginTop: space[6],
    paddingVertical: space[2],
    paddingHorizontal: space[4],
    color: color.accent,
    fontSize: fontSize.lg,
    fontVariant: ['tabular-nums'],
    letterSpacing: fontSize.lg * letterSpacing.wide,
    backgroundColor: color.surfaceRaised,
    borderColor: color.borderStrong,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  footer: {
    color: color.textMuted,
    fontSize: fontSize.xs,
    letterSpacing: fontSize.xs * 0.06,
  },
});
