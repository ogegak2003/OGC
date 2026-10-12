import { color, fontSize, fontWeight, space } from '@ogc/ui';
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

/** Shared scaffold: dark background, keyboard-aware scrolling, consistent title rhythm. */
export function Screen({
  title,
  subtitle,
  onBack,
  children,
}: {
  title?: string;
  subtitle?: string;
  /** Shows a Back control (signed-in stack screens). */
  onBack?: (() => void) | undefined;
  children: ReactNode;
}) {
  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.inner}>
          {onBack ? (
            <Text style={styles.back} accessibilityRole="button" onPress={onBack}>
              ‹ Back
            </Text>
          ) : null}
          {title ? (
            <Text style={styles.title} accessibilityRole="header">
              {title}
            </Text>
          ) : null}
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          {children}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

export const text = StyleSheet.create({
  body: { color: color.textSecondary, fontSize: fontSize.md, lineHeight: 22 },
  strong: { color: color.textPrimary, fontWeight: fontWeight.semibold },
  link: { color: color.accent, fontSize: fontSize.md, textAlign: 'center' },
});

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.background },
  content: { flexGrow: 1, padding: space[6], paddingTop: space[16] },
  inner: { width: '100%', maxWidth: 440, alignSelf: 'center', gap: space[5] },
  title: {
    color: color.textPrimary,
    fontSize: fontSize['3xl'],
    fontWeight: fontWeight.semibold,
    letterSpacing: -0.5,
  },
  subtitle: { color: color.textSecondary, fontSize: fontSize.md, marginTop: -space[3] },
  back: {
    color: color.accent,
    fontSize: fontSize.md,
    alignSelf: 'flex-start',
    paddingVertical: space[1],
  },
});
