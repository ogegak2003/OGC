import { fontSize, fontWeight, radius, space } from '@ogc/ui';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon, type IconName } from '../components/Icon';
import { OgcLogo } from '../components/OgcLogo';
import { Button } from '../components/ui';
import { color, themedStyles } from '../theme';

/** What OGC does today — each line describes a shipped capability. */
const FEATURES: { icon: IconName; title: string; text: string }[] = [
  {
    icon: 'lock',
    title: 'End-to-end encrypted',
    text: 'Direct and group chats are encrypted on your devices.',
  },
  {
    icon: 'user',
    title: 'One OGC ID',
    text: 'People find you by OGC ID or QR — never your email.',
  },
  { icon: 'video', title: 'Voice and video', text: 'Call your contacts from any conversation.' },
  {
    icon: 'megaphone',
    title: 'Groups and channels',
    text: 'Private groups for your people, public channels for your community.',
  },
];

/**
 * The first screen signed-out people see: the OGC brand, a plain statement of what OGC is,
 * what you get, and the existing registration and sign-in flows — reachable with one thumb at
 * the bottom of the screen. No imagery to download, nothing animated.
 */
export function WelcomeScreen({
  onCreate,
  onSignIn,
}: {
  onCreate: () => void;
  onSignIn: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const wide = width >= 720;
  const titleSize = Math.round(Math.min(wide ? 52 : 40, Math.max(30, width * 0.085)));

  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          wide && styles.scrollWide,
          { paddingTop: insets.top + space[6], paddingBottom: insets.bottom + space[6] },
        ]}
      >
        <OgcLogo height={36} />
        <View style={styles.copy}>
          <Text style={styles.eyebrow}>OBAGAGLOBAL COMMUNICATION</Text>
          <Text
            style={[styles.title, { fontSize: titleSize, lineHeight: Math.round(titleSize * 1.1) }]}
            accessibilityRole="header"
          >
            Private conversations, one OGC ID.
          </Text>
          <Text style={styles.lead}>
            Message, call and organise with the people who matter — encrypted on your devices.
          </Text>
        </View>
        <View style={[styles.features, wide && styles.featuresWide]}>
          {FEATURES.map((feature) => (
            <View key={feature.title} style={[styles.feature, wide && styles.featureWide]}>
              <View style={styles.featureIcon}>
                <Icon name={feature.icon} size={20} tint={color.accent} />
              </View>
              <View style={styles.featureText}>
                <Text style={styles.featureTitle}>{feature.title}</Text>
                <Text style={styles.featureBody}>{feature.text}</Text>
              </View>
            </View>
          ))}
        </View>
        <View style={styles.spacer} />
        <View style={[styles.actions, wide && styles.actionsWide]}>
          <Button title="Create Account" icon="arrowRight" onPress={onCreate} />
          <Button title="Sign In" variant="secondary" onPress={onSignIn} />
        </View>
        <Text style={styles.footer}>OGC never shows your email address to other people.</Text>
      </ScrollView>
    </View>
  );
}

const styles = themedStyles(() =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: color.background },
    scroll: {
      flexGrow: 1,
      gap: space[6],
      paddingHorizontal: space[5],
    },
    scrollWide: { alignSelf: 'center', width: '100%', maxWidth: 880, paddingHorizontal: space[8] },
    copy: { gap: space[3], marginTop: space[4] },
    eyebrow: {
      color: color.accent,
      fontSize: fontSize.xs,
      fontWeight: fontWeight.semibold,
      letterSpacing: 1.2,
    },
    title: { color: color.textPrimary, fontWeight: fontWeight.bold, letterSpacing: -0.6 },
    lead: { color: color.textSecondary, fontSize: fontSize.md, lineHeight: 23 },
    features: { gap: space[3] },
    featuresWide: { flexDirection: 'row', flexWrap: 'wrap' },
    feature: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space[3],
      padding: space[4],
      backgroundColor: color.surface,
      borderWidth: 1,
      borderColor: color.border,
      borderRadius: radius.lg,
    },
    featureWide: { flexBasis: '48%', flexGrow: 1 },
    featureIcon: {
      alignItems: 'center',
      justifyContent: 'center',
      width: 40,
      height: 40,
      backgroundColor: color.accentSubtle,
      borderRadius: radius.md,
    },
    featureText: { flex: 1, gap: 2 },
    featureTitle: {
      color: color.textPrimary,
      fontSize: fontSize.sm,
      fontWeight: fontWeight.semibold,
    },
    featureBody: { color: color.textMuted, fontSize: fontSize.sm, lineHeight: 19 },
    spacer: { flexGrow: 1 },
    actions: { gap: space[3] },
    actionsWide: { flexDirection: 'row' },
    footer: { color: color.textMuted, fontSize: fontSize.xs, textAlign: 'center' },
  }),
);
