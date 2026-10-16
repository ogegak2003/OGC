import {
  ACCENT_LABELS,
  THEME_ACCENTS,
  type ThemePreference,
  fontSize,
  fontWeight,
  radius,
  resolveTheme,
  space,
} from '@ogc/ui';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon, type IconName } from '../../components/Icon';
import { SectionHeader } from '../../components/ui';
import { useNavigation } from '../../navigation';
import { color, themedStyles } from '../../theme';
import { useTheme } from '../../theme/ThemeProvider';
import { Screen } from '../Screen';

const MODES: { value: ThemePreference; label: string; hint: string; icon: IconName }[] = [
  { value: 'dark', label: 'Obsidian', hint: 'Dark', icon: 'moon' },
  { value: 'light', label: 'Ivory', hint: 'Light', icon: 'sun' },
  { value: 'system', label: 'System', hint: 'Follows this phone', icon: 'device' },
];

/** One selectable row: a radio in a radio group (announced with its checked state). */
function Choice({
  label,
  hint,
  selected,
  onPress,
  leading,
}: {
  label: string;
  hint?: string;
  selected: boolean;
  onPress: () => void;
  leading: React.ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={hint ? `${label}, ${hint}` : label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.choice,
        selected && styles.choiceSelected,
        pressed && styles.choicePressed,
      ]}
    >
      {leading}
      <View style={styles.choiceText}>
        <Text style={styles.choiceLabel}>{label}</Text>
        {hint ? <Text style={styles.choiceHint}>{hint}</Text> : null}
      </View>
      {selected ? <Icon name="check" size={20} tint={color.accent} /> : null}
    </Pressable>
  );
}

/** Settings → Appearance: Obsidian, Ivory or System, and the accent. Saved on this phone. */
export function AppearanceScreen() {
  const nav = useNavigation();
  const { preference, accent, mode, setPreference, setAccent } = useTheme();
  return (
    <Screen
      title="Appearance"
      subtitle="How OGC looks on this phone. Your choice is saved on this device only."
      onBack={nav.back}
    >
      <SectionHeader title="Mode" />
      <View style={styles.group} accessibilityRole="radiogroup">
        {MODES.map((option) => (
          <Choice
            key={option.value}
            label={option.label}
            hint={option.hint}
            selected={preference === option.value}
            onPress={() => {
              setPreference(option.value);
            }}
            leading={
              <View style={styles.iconTile}>
                <Icon name={option.icon} size={20} tint={color.textSecondary} />
              </View>
            }
          />
        ))}
      </View>
      <SectionHeader title="Accent" />
      <View style={styles.group} accessibilityRole="radiogroup">
        {THEME_ACCENTS.map((option) => (
          <Choice
            key={option}
            label={ACCENT_LABELS[option]}
            selected={accent === option}
            onPress={() => {
              setAccent(option);
            }}
            leading={
              <View
                style={[styles.swatch, { backgroundColor: resolveTheme(mode, option).accent }]}
              />
            }
          />
        ))}
      </View>
    </Screen>
  );
}

const styles = themedStyles(() =>
  StyleSheet.create({
    group: { gap: space[2] },
    choice: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space[3],
      minHeight: 56,
      paddingHorizontal: space[4],
      backgroundColor: color.surface,
      borderWidth: 1,
      borderColor: color.border,
      borderRadius: radius.md,
    },
    choiceSelected: { borderColor: color.accent, backgroundColor: color.accentSubtle },
    choicePressed: { backgroundColor: color.surfaceHover },
    choiceText: { flex: 1, gap: 2 },
    choiceLabel: {
      color: color.textPrimary,
      fontSize: fontSize.md,
      fontWeight: fontWeight.semibold,
    },
    choiceHint: { color: color.textMuted, fontSize: fontSize.sm },
    iconTile: {
      alignItems: 'center',
      justifyContent: 'center',
      width: 36,
      height: 36,
      backgroundColor: color.surfaceRaised,
      borderRadius: radius.sm,
    },
    swatch: {
      width: 28,
      height: 28,
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: color.borderStrong,
    },
  }),
);
