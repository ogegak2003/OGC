import { color, fontSize, fontWeight, radius, space } from '@ogc/ui';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from 'react-native';

export function Button({
  title,
  onPress,
  variant = 'primary',
  busy = false,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost';
  busy?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ busy, disabled: busy }}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => [styles.button, styles[variant], pressed && styles.pressed]}
    >
      {busy ? (
        <ActivityIndicator color={variant === 'primary' ? color.onAccent : color.accent} />
      ) : (
        <Text style={[styles.buttonText, variant === 'primary' && styles.primaryText]}>
          {title}
        </Text>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  error,
  ...input
}: TextInputProps & { label: string; error?: string | undefined }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={color.textDisabled}
        style={[styles.input, error ? styles.inputError : null]}
        {...input}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

export function Notice({
  tone = 'error',
  children,
}: {
  tone?: 'error' | 'success';
  children: ReactNode;
}) {
  return (
    <View
      accessibilityRole="alert"
      style={[styles.notice, tone === 'error' ? styles.noticeError : styles.noticeSuccess]}
    >
      <Text style={styles.noticeText}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space[6],
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  primary: { backgroundColor: color.accent },
  secondary: { borderColor: color.borderStrong },
  ghost: { minHeight: 40 },
  pressed: { opacity: 0.85 },
  buttonText: { color: color.textPrimary, fontSize: fontSize.md, fontWeight: fontWeight.semibold },
  primaryText: { color: color.onAccent },
  field: { gap: space[2] },
  label: { color: color.textSecondary, fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  input: {
    minHeight: 50,
    paddingHorizontal: space[4],
    color: color.textPrimary,
    fontSize: fontSize.md,
    backgroundColor: color.background,
    borderWidth: 1,
    borderColor: color.borderStrong,
    borderRadius: radius.md,
  },
  inputError: { borderColor: color.danger },
  error: { color: color.danger, fontSize: fontSize.sm },
  notice: { padding: space[3], borderRadius: radius.md, borderWidth: 1 },
  noticeError: { borderColor: color.danger },
  noticeSuccess: { borderColor: color.success },
  noticeText: { color: color.textPrimary, fontSize: fontSize.sm },
});
