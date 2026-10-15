import { color, fontSize, fontWeight, size, space } from '@ogc/ui';
import { type ReactNode, createContext, useContext } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { OgcMark } from '../components/Icon';
import { IconButton } from '../components/ui';

/** True inside a bottom-navigation destination: the tab bar owns the bottom safe area. */
export const InTabsContext = createContext(false);

/**
 * Compact top bar for stack screens: Back, a title (or custom content) and
 * trailing actions. Sits below the status bar (safe area).
 */
export function AppBar({
  title,
  subtitle,
  onBack,
  actions,
  children,
}: {
  title?: string | undefined;
  subtitle?: string | undefined;
  onBack?: (() => void) | undefined;
  actions?: ReactNode;
  /** Replaces the title block (e.g. a conversation's participant). */
  children?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingTop: insets.top }]}>
      <View style={styles.barRow}>
        {onBack ? (
          <IconButton icon="back" label="Back" onPress={onBack} />
        ) : (
          <View style={styles.barSpacer} />
        )}
        {children ?? (
          <View style={styles.barTitles}>
            {title ? (
              <Text style={styles.barTitle} accessibilityRole="header" numberOfLines={1}>
                {title}
              </Text>
            ) : null}
            {subtitle ? (
              <Text style={styles.barSubtitle} numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
          </View>
        )}
        <View style={styles.barActions}>{actions}</View>
      </View>
    </View>
  );
}

/**
 * Shared scaffold: dark canvas, safe areas, keyboard-aware scrolling and a
 * consistent title rhythm. With `onBack` it shows a compact app bar (stack
 * screens); without, a large title (destinations and sign-in flows).
 */
export function Screen({
  title,
  subtitle,
  onBack,
  actions,
  children,
  scroll = true,
}: {
  title?: string;
  subtitle?: string;
  /** Shows a Back control (signed-in stack screens). */
  onBack?: (() => void) | undefined;
  /** Trailing app-bar controls (IconButtons). */
  actions?: ReactNode;
  children: ReactNode;
  /** `false` for screens that manage their own list (FlatList). */
  scroll?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const inTabs = useContext(InTabsContext);
  const bottom = (inTabs ? 0 : insets.bottom) + space[8];
  const compact = onBack !== undefined;

  const heading = compact ? (
    subtitle ? (
      <Text style={styles.subtitle}>{subtitle}</Text>
    ) : null
  ) : title || subtitle || actions ? (
    <View style={[styles.largeHeader, !title && styles.largeHeaderBare]}>
      <View style={styles.largeTitles}>
        {title ? (
          <Text style={styles.title} accessibilityRole="header">
            {title}
          </Text>
        ) : null}
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
      {actions ? <View style={styles.barActions}>{actions}</View> : null}
    </View>
  ) : null;

  const body = (
    <View style={styles.inner}>
      {heading}
      {children}
    </View>
  );

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {compact ? (
        <AppBar title={title} onBack={onBack} actions={actions} />
      ) : (
        <View style={{ height: insets.top }} />
      )}
      {scroll ? (
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: bottom }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          {body}
        </ScrollView>
      ) : (
        <View style={[styles.content, styles.fill, { paddingBottom: inTabs ? 0 : insets.bottom }]}>
          {body}
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

/** Brand lockup: the OGC mark and wordmark. */
export function Wordmark({ size = 28 }: { size?: number }) {
  return (
    <View style={styles.wordmark} accessible accessibilityLabel="OGC">
      <OgcMark size={size} />
      <Text style={[styles.wordmarkText, { fontSize: size * 0.62 }]}>OGC</Text>
    </View>
  );
}

/**
 * Layout for the signed-out flows (welcome, sign-in, registration, verification):
 * brand lockup, a confident title and a single readable column.
 */
export function AuthScreen({
  title,
  subtitle,
  onBack,
  children,
  footer,
}: {
  title?: string;
  subtitle?: ReactNode;
  onBack?: (() => void) | undefined;
  children: ReactNode;
  /** Secondary links pinned below the form (e.g. "Already have an OGC ID?"). */
  footer?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.authContent,
          { paddingTop: insets.top + space[2], paddingBottom: insets.bottom + space[6] },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.authInner}>
          <View style={[styles.authTop, onBack ? styles.authTopBack : null]}>
            {onBack ? <IconButton icon="back" label="Back" onPress={onBack} /> : null}
            <Wordmark />
          </View>
          {title ? (
            <View style={styles.authTitles}>
              <Text style={styles.authTitle} accessibilityRole="header">
                {title}
              </Text>
              {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
            </View>
          ) : null}
          {children}
          {footer ? <View style={styles.authFooter}>{footer}</View> : null}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

export const text = StyleSheet.create({
  body: { color: color.textSecondary, fontSize: fontSize.md, lineHeight: 23 },
  strong: { color: color.textPrimary, fontWeight: fontWeight.semibold },
  link: {
    color: color.accent,
    fontSize: fontSize.md,
    fontWeight: fontWeight.medium,
    textAlign: 'center',
    paddingVertical: space[3],
  },
  muted: { color: color.textMuted, fontSize: fontSize.sm, lineHeight: 20 },
});

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.background },
  content: { flexGrow: 1, paddingHorizontal: space[5], paddingTop: space[4] },
  fill: { flex: 1 },
  inner: { width: '100%', maxWidth: 560, alignSelf: 'center', gap: space[5] },
  largeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    paddingTop: space[2],
  },
  largeHeaderBare: { paddingTop: 0 },
  largeTitles: { flex: 1, gap: space[1] },
  title: {
    color: color.textPrimary,
    fontSize: fontSize['2xl'],
    fontWeight: fontWeight.bold,
    letterSpacing: -0.4,
  },
  subtitle: { color: color.textSecondary, fontSize: fontSize.md, lineHeight: 22 },
  bar: {
    backgroundColor: color.background,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  barRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
    minHeight: size.appBar,
    paddingHorizontal: space[2],
  },
  barSpacer: { width: space[2] },
  barTitles: { flex: 1, paddingHorizontal: space[1] },
  barTitle: { color: color.textPrimary, fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
  barSubtitle: { color: color.textMuted, fontSize: fontSize.xs },
  barActions: { flexDirection: 'row', alignItems: 'center' },
  wordmark: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  wordmarkText: { color: color.textPrimary, fontWeight: fontWeight.bold, letterSpacing: 5 },
  authContent: { flexGrow: 1, paddingHorizontal: space[6] },
  authInner: {
    flex: 1,
    width: '100%',
    maxWidth: size.formWidth,
    alignSelf: 'center',
    gap: space[5],
  },
  authTop: { flexDirection: 'row', alignItems: 'center', gap: space[2], minHeight: 52 },
  authTopBack: { marginLeft: -space[3] },
  authTitles: { gap: space[2], marginTop: space[4] },
  authTitle: {
    color: color.textPrimary,
    fontSize: fontSize['3xl'] - 4,
    fontWeight: fontWeight.bold,
    letterSpacing: -0.5,
    lineHeight: 36,
  },
  authFooter: { marginTop: 'auto', paddingTop: space[4], alignItems: 'center' },
});
