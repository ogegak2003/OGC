import { fontSize, fontWeight, radius, space } from '@ogc/ui';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '../navigation';
import { color, themedStyles } from '../theme';
import { Icon, type IconName } from './Icon';
import { Button } from './ui';

export type ErrorKind = 'not-found' | 'forbidden' | 'unavailable';

const KIND: Record<ErrorKind, { code: string; icon: IconName }> = {
  'not-found': { code: '404', icon: 'compass' },
  forbidden: { code: '403', icon: 'shield' },
  unavailable: { code: '410', icon: 'clock' },
};

/**
 * Branded "not found / no access / no longer available" state for native screens: what
 * happened, in plain words, a way Home and (when there is one) a way back. Says no more than
 * the server did, so it never reveals whether something private exists.
 */
export function ErrorState({
  kind,
  title,
  children,
}: {
  kind: ErrorKind;
  title: string;
  children?: ReactNode;
}) {
  const nav = useNavigation();
  const { code, icon } = KIND[kind];
  return (
    <View style={styles.state}>
      <View
        style={styles.badge}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Icon name={icon} size={28} tint={color.accent} />
      </View>
      <Text style={styles.code} accessibilityElementsHidden importantForAccessibility="no">
        {code}
      </Text>
      <Text style={styles.title} accessibilityRole="header">
        {title}
      </Text>
      {children ? <Text style={styles.text}>{children}</Text> : null}
      <View style={styles.actions}>
        <Button
          title="Go to Home"
          icon="home"
          onPress={() => {
            nav.tab('home');
          }}
        />
        {nav.canGoBack ? (
          <Button title="Go back" icon="back" variant="secondary" onPress={nav.back} />
        ) : null}
      </View>
    </View>
  );
}

const styles = themedStyles(() =>
  StyleSheet.create({
    state: {
      alignItems: 'center',
      gap: space[3],
      marginTop: space[6],
      paddingHorizontal: space[5],
      paddingVertical: space[8],
      backgroundColor: color.surface,
      borderWidth: 1,
      borderColor: color.border,
      borderRadius: radius.lg,
    },
    badge: {
      width: 64,
      height: 64,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 32,
      borderWidth: 1,
      borderColor: color.accentBorder,
      backgroundColor: color.accentSubtle,
    },
    code: { color: color.textMuted, fontSize: fontSize.sm, letterSpacing: 4 },
    title: {
      color: color.textPrimary,
      fontSize: fontSize.xl,
      fontWeight: fontWeight.bold,
      textAlign: 'center',
    },
    text: {
      color: color.textSecondary,
      fontSize: fontSize.md,
      lineHeight: 22,
      textAlign: 'center',
    },
    actions: { alignSelf: 'stretch', gap: space[2], marginTop: space[2] },
  }),
);
