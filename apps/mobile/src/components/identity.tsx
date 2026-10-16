import type { OgcId } from '@ogc/types';
import { fontSize, fontWeight, radius, space } from '@ogc/ui';
import { buildOgcIdLink, formatOgcIdForDisplay } from '@ogc/validation';
import * as Clipboard from 'expo-clipboard';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  AccessibilityInfo,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { qrSvgPath } from '@ogc/ui';
import { useAuth } from '../auth/AuthProvider';
import { shareIdentity } from '../lib/share';
import { Icon, type IconName } from './Icon';
import { color, themeMode, themedStyles } from '../theme';

export const monoFont = Platform.select({ ios: 'Menlo', android: 'monospace' });

function QrSvg({ payload, size }: { payload: string; size: number }) {
  const { path, size: modules } = useMemo(() => qrSvgPath(payload), [payload]);
  const quiet = 2;
  const box = modules + quiet * 2;
  return (
    <Svg
      width={size}
      height={size}
      viewBox={`${String(-quiet)} ${String(-quiet)} ${String(box)} ${String(box)}`}
    >
      {/* Light quiet zone behind the dark modules, for reliable scanning. */}
      <Path
        d={`M${String(-quiet)} ${String(-quiet)}h${String(box)}v${String(box)}h${String(-box)}z`}
        fill={color.textPrimary}
      />
      <Path d={path} fill={color.background} />
    </Svg>
  );
}

/**
 * QR code for an OGC identity. Encodes only `ogc://id/<OGC ID>` — never tokens,
 * credentials, keys, or private data (ADR-013). Same matrix as the web app.
 */
export function OgcQrCode({ ogcId, size = 220 }: { ogcId: OgcId; size?: number }) {
  const link = buildOgcIdLink(ogcId);
  return (
    <View
      style={styles.qrFrame}
      accessibilityRole="image"
      accessibilityLabel={`QR code for ${ogcId}`}
      testID="ogc-qr"
      accessibilityHint={link}
    >
      <QrSvg payload={link} size={size} />
    </View>
  );
}

/**
 * QR code for a link the user chose to share (e.g. an invitation link). The
 * caller decides what may be encoded; identity QR codes use `OgcQrCode`.
 */
export function LinkQrCode({
  payload,
  label,
  size = 220,
}: {
  payload: string;
  label: string;
  size?: number;
}) {
  return (
    <View style={styles.qrFrame} accessibilityRole="image" accessibilityLabel={label}>
      <QrSvg payload={payload} size={size} />
    </View>
  );
}

/** Quiet, dark tints for initials, chosen from the name so a person keeps their colour. */
/** Initials backgrounds: quiet tints, one set per mode so the initials stay readable. */
const TONES = {
  dark: ['#2E2413', '#1A2129', '#221B27', '#14221C', '#2A1B17', '#20211A'],
  light: ['#EFE4CC', '#DDE6F0', '#E8DFEC', '#DCEDE4', '#F1E0D9', '#E6E6D8'],
} as const;

function toneFor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  const tones = TONES[themeMode()];
  return tones[hash % tones.length] ?? tones[0];
}

export function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || '·'
  );
}

/** Profile photo fetched with the session token (so privacy rules apply), with an initials fallback. */
export function Avatar({
  url,
  name,
  size = 48,
  ring = false,
}: {
  url: string | null;
  name: string;
  size?: number;
  /** Gold ring: the signed-in user's own avatar. */
  ring?: boolean;
}) {
  const { client } = useAuth();
  const [failed, setFailed] = useState(false);
  const source = client.avatarSource(url);
  const dimension = { width: size, height: size, borderRadius: size / 2 };
  const ringStyle = ring ? { borderColor: color.accent, borderWidth: 1.5 } : null;

  if (source && !failed) {
    return (
      <Image
        source={source}
        style={[styles.avatar, dimension, ringStyle]}
        accessibilityIgnoresInvertColors
        onError={() => {
          setFailed(true);
        }}
      />
    );
  }
  return (
    <View
      style={[styles.fallback, dimension, { backgroundColor: toneFor(name) }, ringStyle]}
      accessible={false}
    >
      <Text
        style={[styles.initials, { fontSize: Math.round(size * 0.38) }]}
        allowFontScaling={false}
      >
        {initialsOf(name)}
      </Text>
    </View>
  );
}

/**
 * An avatar marked with what kind of space it is: a lock (green) for an end-to-end encrypted
 * group, a megaphone for a channel — green when it is an encrypted private channel, accent when it
 * is an open community channel. Keeps groups and community channels visibly distinct.
 */
export function KindAvatar({
  url,
  name,
  size = 48,
  kind,
}: {
  url: string | null;
  name: string;
  size?: number;
  kind: 'group' | 'encrypted-channel' | 'community-channel';
}) {
  const encrypted = kind !== 'community-channel';
  return (
    <View style={styles.kindWrap}>
      <Avatar url={url} name={name} size={size} />
      <View style={[styles.kindBadge, encrypted ? styles.kindSecure : styles.kindCommunity]}>
        <Icon
          name={kind === 'group' ? 'lock' : 'megaphone'}
          size={11}
          tint={encrypted ? color.background : color.onAccent}
        />
      </View>
    </View>
  );
}

/** The OGC ID in its distinctive form: monospaced, tracked, champagne. */
export function OgcIdText({ ogcId, size = 'md' }: { ogcId: OgcId; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <Text
      style={[styles.ogcId, size === 'lg' ? styles.ogcIdLg : size === 'sm' ? styles.ogcIdSm : null]}
      accessibilityLabel={ogcId}
      selectable
    >
      {formatOgcIdForDisplay(ogcId)}
    </Text>
  );
}

function IdentityAction({
  icon,
  label,
  onPress,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
    >
      <Icon name={icon} size={18} tint={color.accentHighlight} />
      <Text style={styles.actionText} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Copies text and announces it; returns a "copied" flag that resets after a moment. */
export function useCopy(): [boolean, (value: string) => void] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => {
      setCopied(false);
    }, 2000);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);
  const copy = (value: string) => {
    void Clipboard.setStringAsync(value).then(
      () => {
        setCopied(true);
        AccessibilityInfo.announceForAccessibility('Copied');
      },
      () => undefined,
    );
  };
  return [copied, copy];
}

/**
 * The user's own identity: their OGC ID with copy, share and QR. The only
 * place the gold-tinted identity treatment is used.
 */
export function IdentityCard({
  ogcId,
  displayName,
  onShowQr,
  children,
}: {
  ogcId: OgcId;
  displayName: string;
  onShowQr: () => void;
  /** Extra content above the actions (e.g. a greeting). */
  children?: ReactNode;
}) {
  const [copied, copy] = useCopy();
  return (
    <View style={styles.identity}>
      {children}
      <View style={styles.identityTop}>
        <View style={styles.identityText}>
          <Text style={styles.overline}>YOUR OGC ID</Text>
          <OgcIdText ogcId={ogcId} size="lg" />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Show my QR code"
          onPress={onShowQr}
          style={({ pressed }) => [styles.qrShortcut, pressed && styles.actionPressed]}
        >
          <Icon name="qr" size={26} tint={color.accent} />
        </Pressable>
      </View>
      <View style={styles.actions}>
        <IdentityAction
          icon={copied ? 'check' : 'copy'}
          label={copied ? 'Copied' : 'Copy ID'}
          onPress={() => {
            copy(ogcId);
          }}
        />
        <IdentityAction
          icon="share"
          label="Share my OGC"
          onPress={() => void shareIdentity(ogcId, displayName)}
        />
      </View>
    </View>
  );
}

const styles = themedStyles(() =>
  StyleSheet.create({
    kindWrap: { position: 'relative' },
    kindBadge: {
      position: 'absolute',
      right: -2,
      bottom: -2,
      width: 20,
      height: 20,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 2,
      borderColor: color.background,
      borderRadius: 10,
    },
    kindSecure: { backgroundColor: color.success },
    kindCommunity: { backgroundColor: color.accent },
    qrFrame: {
      alignSelf: 'center',
      padding: space[3],
      backgroundColor: color.textPrimary,
      borderRadius: radius.lg,
      borderWidth: 2,
      borderColor: color.accent,
    },
    avatar: {
      backgroundColor: color.surfaceRaised,
      borderWidth: 1,
      borderColor: color.borderStrong,
    },
    fallback: {
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: color.border,
    },
    initials: { color: color.accentHighlight, fontWeight: fontWeight.semibold },
    ogcId: {
      color: color.accentHighlight,
      fontSize: fontSize.sm,
      letterSpacing: 1.5,
      fontVariant: ['tabular-nums'],
      fontFamily: monoFont,
    },
    ogcIdSm: { fontSize: fontSize.xs, letterSpacing: 1 },
    ogcIdLg: { fontSize: fontSize.xl, letterSpacing: 2.5, color: color.textPrimary },
    identity: {
      gap: space[4],
      padding: space[5],
      backgroundColor: color.accentSubtle,
      borderWidth: 1,
      borderColor: color.accentBorder,
      borderRadius: radius.xl,
    },
    identityTop: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
    identityText: { flex: 1, gap: space[1] },
    overline: {
      color: color.accent,
      fontSize: fontSize.xs,
      fontWeight: fontWeight.semibold,
      letterSpacing: 1.8,
    },
    qrShortcut: {
      width: 52,
      height: 52,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: color.accentBorder,
      backgroundColor: color.accentSubtle,
    },
    actions: { flexDirection: 'row', gap: space[2] },
    action: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: space[2],
      minHeight: 44,
      paddingHorizontal: space[3],
      borderRadius: radius.md,
      backgroundColor: color.accentSubtle,
    },
    actionPressed: { opacity: 0.7 },
    actionText: {
      color: color.accentHighlight,
      fontSize: fontSize.sm,
      fontWeight: fontWeight.semibold,
    },
  }),
);
