import { color, fontSize, fontWeight, radius, size, space } from '@ogc/ui';
import { type ReactNode, useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Pressable,
  type StyleProp,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  type TextInputProps,
  View,
  type ViewStyle,
} from 'react-native';
import { Icon, type IconName } from './Icon';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/** The OGC button. Gold (primary) is reserved for the main action of a screen. */
export function Button({
  title,
  onPress,
  variant = 'primary',
  busy = false,
  disabled = false,
  icon,
  compact = false,
  accessibilityLabel,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  busy?: boolean;
  disabled?: boolean;
  icon?: IconName;
  /** Smaller height for inline and row actions. */
  compact?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const inactive = busy || disabled;
  const tint =
    variant === 'primary'
      ? color.onAccent
      : variant === 'danger'
        ? color.danger
        : variant === 'ghost'
          ? color.textSecondary
          : color.textPrimary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ busy, disabled: inactive }}
      {...(accessibilityLabel ? { accessibilityLabel } : {})}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        compact && styles.compact,
        styles[variant],
        pressed && (variant === 'primary' ? styles.primaryPressed : styles.pressed),
        disabled && !busy && styles.disabled,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={variant === 'primary' ? color.onAccent : color.accent} />
      ) : (
        <>
          {icon ? <Icon name={icon} size={compact ? 18 : 20} tint={tint} /> : null}
          <Text
            style={[styles.buttonText, compact && styles.compactText, { color: tint }]}
            numberOfLines={1}
          >
            {title}
          </Text>
        </>
      )}
    </Pressable>
  );
}

/** A 44pt icon-only control. `label` is what screen readers announce. */
export function IconButton({
  icon,
  label,
  onPress,
  tint = color.textPrimary,
  badge,
  filled = false,
  disabled = false,
  size: iconSize = 22,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  tint?: string;
  /** Unread count shown on the corner (0 hides it). */
  badge?: number;
  /** Gold circular fill (e.g. Send). */
  filled?: boolean;
  disabled?: boolean;
  size?: number;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        filled && styles.iconButtonFilled,
        pressed && (filled ? styles.primaryPressed : styles.iconButtonPressed),
        disabled && styles.disabled,
      ]}
    >
      <Icon name={icon} size={iconSize} tint={filled ? color.onAccent : tint} />
      {badge && badge > 0 ? (
        <View style={styles.cornerBadge} accessible={false}>
          <Text style={styles.cornerBadgeText}>{badge > 99 ? '99+' : badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

export function Field({
  label,
  error,
  hint,
  icon,
  secureTextEntry,
  ...input
}: TextInputProps & {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
  icon?: IconName;
}) {
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View
        style={[
          styles.inputWrap,
          focused && styles.inputFocused,
          error ? styles.inputError : null,
          input.multiline ? styles.inputMultiline : null,
        ]}
      >
        {icon ? <Icon name={icon} size={20} tint={color.textMuted} /> : null}
        <TextInput
          accessibilityLabel={label}
          placeholderTextColor={color.textDisabled}
          selectionColor={color.accent}
          cursorColor={color.accent}
          style={[styles.input, input.multiline ? styles.inputTextMultiline : null]}
          secureTextEntry={secureTextEntry === true && !revealed}
          {...input}
          onFocus={(event) => {
            setFocused(true);
            input.onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            input.onBlur?.(event);
          }}
        />
        {secureTextEntry ? (
          <IconButton
            icon={revealed ? 'eyeOff' : 'eye'}
            label={revealed ? 'Hide password' : 'Show password'}
            tint={color.textMuted}
            size={20}
            onPress={() => {
              setRevealed((value) => !value);
            }}
          />
        ) : null}
      </View>
      {error ? (
        <Text style={styles.error}>{error}</Text>
      ) : hint ? (
        <Text style={styles.hint}>{hint}</Text>
      ) : null}
    </View>
  );
}

const NOTICE: Record<
  'error' | 'success' | 'info' | 'warning',
  { icon: IconName; tint: string; fill: string }
> = {
  error: { icon: 'alert', tint: color.danger, fill: color.dangerSubtle },
  success: { icon: 'check', tint: color.success, fill: color.successSubtle },
  info: { icon: 'info', tint: color.info, fill: color.infoSubtle },
  warning: { icon: 'alert', tint: color.warning, fill: color.warningSubtle },
};

export function Notice({
  tone = 'error',
  children,
  action,
}: {
  tone?: 'error' | 'success' | 'info' | 'warning';
  children: ReactNode;
  /** e.g. a Retry button. */
  action?: { label: string; onPress: () => void } | undefined;
}) {
  const look = NOTICE[tone];
  return (
    <View
      accessibilityRole={tone === 'error' ? 'alert' : 'summary'}
      style={[styles.notice, { backgroundColor: look.fill, borderColor: `${look.tint}55` }]}
    >
      <Icon name={look.icon} size={18} tint={look.tint} />
      <Text style={styles.noticeText}>{children}</Text>
      {action ? (
        <Text style={styles.noticeAction} accessibilityRole="button" onPress={action.onPress}>
          {action.label}
        </Text>
      ) : null}
    </View>
  );
}

/** A raised surface. Avoid nesting cards inside cards. */
export function Card({
  children,
  style,
  tone = 'default',
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** `identity`: the gold-tinted card reserved for the user's OGC identity. */
  tone?: 'default' | 'identity';
}) {
  return (
    <View style={[styles.card, tone === 'identity' && styles.identityCard, style]}>{children}</View>
  );
}

/** Small uppercase heading above a group of rows, with an optional action. */
export function SectionHeader({
  title,
  action,
}: {
  title: string;
  action?: { label: string; onPress: () => void } | undefined;
}) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle} accessibilityRole="header">
        {title}
      </Text>
      {action ? (
        <Text style={styles.sectionAction} accessibilityRole="button" onPress={action.onPress}>
          {action.label}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * A list row: leading visual, title, subtitle and trailing content. Rows in a
 * group share one rounded container (`ListGroup`).
 */
export function ListRow({
  title,
  subtitle,
  leading,
  icon,
  trailing,
  onPress,
  chevron = onPress !== undefined,
  tone = 'default',
  accessibilityLabel,
}: {
  title: string;
  subtitle?: string | undefined;
  leading?: ReactNode;
  /** Shorthand for an icon tile as the leading visual. */
  icon?: IconName;
  trailing?: ReactNode;
  onPress?: (() => void) | undefined;
  chevron?: boolean;
  tone?: 'default' | 'danger' | 'accent';
  accessibilityLabel?: string;
}) {
  const content = (
    <>
      {leading ??
        (icon ? (
          <View style={[styles.iconTile, tone === 'danger' && styles.iconTileDanger]}>
            <Icon
              name={icon}
              size={20}
              tint={
                tone === 'danger'
                  ? color.danger
                  : tone === 'accent'
                    ? color.accent
                    : color.textPrimary
              }
            />
          </View>
        ) : null)}
      <View style={styles.rowBody}>
        <Text
          style={[
            styles.rowTitle,
            tone === 'danger' && { color: color.danger },
            tone === 'accent' && { color: color.accent },
          ]}
          numberOfLines={1}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.rowSubtitle} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
      {chevron ? <Icon name="chevronRight" size={18} tint={color.textMuted} /> : null}
    </>
  );
  if (!onPress) {
    return <View style={styles.row}>{content}</View>;
  }
  return (
    <Pressable
      accessibilityRole="button"
      {...(accessibilityLabel ? { accessibilityLabel } : {})}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      {content}
    </Pressable>
  );
}

/** Groups rows in one rounded surface with hairline separators. */
export function ListGroup({ children }: { children: ReactNode }) {
  const items = (Array.isArray(children) ? children : [children]).flat().filter(Boolean);
  return (
    <View style={styles.group}>
      {items.map((child, index) => (
        <View key={index} style={index > 0 ? styles.groupDivider : null}>
          {child}
        </View>
      ))}
    </View>
  );
}

/** An unread count. Screen readers get the label from the row that contains it. */
export function CountBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <View style={styles.countBadge} accessible={false}>
      <Text style={styles.countBadgeText}>{count > 999 ? '999+' : count}</Text>
    </View>
  );
}

/** A small status label (e.g. "Private", "Request sent"). */
export function Tag({
  label,
  tone = 'neutral',
  icon,
}: {
  label: string;
  tone?: 'neutral' | 'accent' | 'success' | 'danger';
  icon?: IconName;
}) {
  const tint =
    tone === 'accent'
      ? color.accent
      : tone === 'success'
        ? color.success
        : tone === 'danger'
          ? color.danger
          : color.textSecondary;
  return (
    <View
      style={[
        styles.tag,
        tone === 'accent' && {
          backgroundColor: color.accentSubtle,
          borderColor: color.accentBorder,
        },
      ]}
    >
      {icon ? <Icon name={icon} size={14} tint={tint} /> : null}
      <Text style={[styles.tagText, { color: tint }]}>{label}</Text>
    </View>
  );
}

/** Segmented tabs (role "tab"). */
export function Tabs<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { id: T; label: string; count?: number }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.tabs} accessibilityRole="tablist">
      {options.map((option) => {
        const selected = option.id === value;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={option.label}
            style={[styles.tab, selected && styles.tabActive]}
            onPress={() => {
              onChange(option.id);
            }}
          >
            <Text style={[styles.tabText, selected && styles.tabTextActive]} numberOfLines={1}>
              {option.label}
            </Text>
            {option.count ? <CountBadge count={option.count} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** A labelled switch with an optional explanation. */
export function SwitchRow({
  label,
  description,
  value,
  onValueChange,
  disabled = false,
}: {
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.switchRow}>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle}>{label}</Text>
        {description ? <Text style={styles.rowSubtitle}>{description}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        accessibilityLabel={label}
        trackColor={{ false: color.borderStrong, true: color.accentPressed }}
        thumbColor={value ? color.accentHighlight : color.textSecondary}
        ios_backgroundColor={color.borderStrong}
      />
    </View>
  );
}

/** Calm, honest empty state with an optional next step. */
export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: IconName;
  title: string;
  body?: string;
  action?: { label: string; onPress: () => void; icon?: IconName } | undefined;
}) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Icon name={icon} size={26} tint={color.accent} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      {body ? <Text style={styles.emptyBody}>{body}</Text> : null}
      {action ? (
        <Button
          title={action.label}
          variant="secondary"
          compact
          {...(action.icon ? { icon: action.icon } : {})}
          onPress={action.onPress}
        />
      ) : null}
    </View>
  );
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(
      (value) => {
        if (active) setReduced(value);
      },
      () => undefined,
    );
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}

/** A placeholder block that gently pulses while content loads (static with reduced motion). */
export function Skeleton({
  width = '100%',
  height = 14,
  round = false,
}: {
  width?: number | `${number}%`;
  height?: number;
  round?: boolean;
}) {
  const reduced = useReducedMotion();
  const [opacity] = useState(() => new Animated.Value(0.55));
  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.55, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [opacity, reduced]);
  return (
    <Animated.View
      style={[
        styles.skeleton,
        { width, height, borderRadius: round ? height / 2 : radius.sm, opacity },
      ]}
    />
  );
}

/** Rows of avatar + two lines, for lists that are loading. */
export function SkeletonRows({ count = 3, label }: { count?: number; label: string }) {
  return (
    <View accessible accessibilityLabel={label} accessibilityRole="progressbar">
      {Array.from({ length: count }, (_, index) => (
        <View key={index} style={styles.skeletonRow}>
          <Skeleton width={size.avatarMd} height={size.avatarMd} round />
          <View style={styles.skeletonLines}>
            <Skeleton width="55%" height={14} />
            <Skeleton width="80%" height={12} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** Centred spinner for whole-screen loading. */
export function Loading({ label }: { label: string }) {
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={color.accent} accessibilityLabel={label} />
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    gap: space[2],
    minHeight: size.control,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space[5],
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  compact: { minHeight: 40, paddingHorizontal: space[4], borderRadius: radius.sm + 2 },
  primary: { backgroundColor: color.accent },
  primaryPressed: { backgroundColor: color.accentPressed },
  secondary: { backgroundColor: color.surfaceRaised, borderColor: color.borderStrong },
  ghost: { minHeight: size.touch, paddingHorizontal: space[3] },
  danger: { backgroundColor: color.dangerSubtle, borderColor: `${color.danger}44` },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.45 },
  buttonText: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, flexShrink: 1 },
  compactText: { fontSize: fontSize.sm },
  iconButton: {
    width: size.touch,
    height: size.touch,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: size.touch / 2,
  },
  iconButtonFilled: { backgroundColor: color.accent },
  iconButtonPressed: { backgroundColor: color.surfaceHover },
  cornerBadge: {
    position: 'absolute',
    top: 4,
    right: 2,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.accent,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: color.background,
  },
  cornerBadgeText: { color: color.onAccent, fontSize: 10, fontWeight: fontWeight.bold },
  field: { gap: space[2] },
  label: { color: color.textSecondary, fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    minHeight: size.control + 2,
    paddingLeft: space[4],
    paddingRight: space[1],
    backgroundColor: color.surfaceRaised,
    borderWidth: 1,
    borderColor: color.borderStrong,
    borderRadius: radius.md,
  },
  inputMultiline: { alignItems: 'flex-start', paddingVertical: space[2] },
  inputFocused: { borderColor: color.accent },
  inputError: { borderColor: color.danger },
  input: {
    flex: 1,
    minHeight: size.control,
    paddingRight: space[3],
    color: color.textPrimary,
    fontSize: fontSize.md,
  },
  inputTextMultiline: { minHeight: 96, textAlignVertical: 'top', paddingTop: space[2] },
  hint: { color: color.textMuted, fontSize: fontSize.sm },
  error: { color: color.danger, fontSize: fontSize.sm },
  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space[3],
    padding: space[3],
    borderRadius: radius.md,
    borderWidth: 1,
  },
  noticeText: { flex: 1, color: color.textPrimary, fontSize: fontSize.sm, lineHeight: 20 },
  noticeAction: {
    color: color.accent,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    paddingHorizontal: space[1],
  },
  card: {
    gap: space[4],
    padding: space[5],
    backgroundColor: color.surface,
    borderColor: color.border,
    borderWidth: 1,
    borderRadius: radius.lg,
  },
  identityCard: { backgroundColor: color.accentSubtle, borderColor: color.accentBorder },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space[2],
    marginBottom: -space[2],
  },
  sectionTitle: {
    color: color.textMuted,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  sectionAction: {
    color: color.accent,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    paddingVertical: space[2],
    paddingLeft: space[3],
  },
  group: {
    backgroundColor: color.surface,
    borderColor: color.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  groupDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.borderStrong },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: 60,
    paddingHorizontal: space[4],
    paddingVertical: space[3],
  },
  rowPressed: { backgroundColor: color.surfaceHover },
  rowBody: { flex: 1, gap: 2 },
  rowTitle: { color: color.textPrimary, fontSize: fontSize.md, fontWeight: fontWeight.medium },
  rowSubtitle: { color: color.textMuted, fontSize: fontSize.sm, lineHeight: 19 },
  iconTile: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.sm + 2,
  },
  iconTileDanger: { backgroundColor: color.dangerSubtle },
  countBadge: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.accent,
    borderRadius: 11,
  },
  countBadgeText: { color: color.onAccent, fontSize: fontSize.xs, fontWeight: fontWeight.bold },
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    paddingHorizontal: space[2] + 2,
    paddingVertical: 3,
    backgroundColor: color.surfaceRaised,
    borderWidth: 1,
    borderColor: color.borderStrong,
    borderRadius: radius.full,
  },
  tagText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold },
  tabs: {
    flexDirection: 'row',
    gap: space[1],
    padding: space[1],
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.md,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    gap: space[1],
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space[2],
    borderRadius: radius.sm,
  },
  tabActive: { backgroundColor: color.surfaceHover },
  tabText: { color: color.textMuted, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  tabTextActive: { color: color.accentHighlight },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: 60,
    paddingHorizontal: space[4],
    paddingVertical: space[3],
  },
  empty: {
    alignItems: 'center',
    gap: space[3],
    paddingVertical: space[10],
    paddingHorizontal: space[4],
  },
  emptyIcon: {
    width: 56,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.accentSubtle,
    borderColor: color.accentBorder,
    borderWidth: 1,
    borderRadius: 28,
  },
  emptyTitle: {
    color: color.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
    textAlign: 'center',
  },
  emptyBody: {
    color: color.textMuted,
    fontSize: fontSize.sm,
    lineHeight: 20,
    textAlign: 'center',
    maxWidth: 320,
  },
  skeleton: { backgroundColor: color.surfaceHover },
  skeletonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    paddingHorizontal: space[4],
    paddingVertical: space[3],
  },
  skeletonLines: { flex: 1, gap: space[2] },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space[8] },
});
