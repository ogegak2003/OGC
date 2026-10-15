import { LOGO_TAGLINE, color, fontSize, fontWeight, space } from '@ogc/ui';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, {
  Circle,
  Defs,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';
import { Icon } from '../components/Icon';
import { OgcLogo } from '../components/OgcLogo';
import { useReducedMotion } from '../components/ui';
/** Rendered by `scripts/generate-globe.mjs` from NASA imagery; its corners match the canvas. */
import GLOBE from '../../assets/welcome-globe.jpg';

/** Tablets and large screens put the copy beside the Earth instead of below it. */
const WIDE = 900;
/** The globe disc fills this share of the square image (`RADIUS` in the generator). */
const DISC = 0.8;
/** The tagline set as two centred lines, as on the brand artwork. */
const TAGLINE_LINES = LOGO_TAGLINE.replace(' WITHOUT', '\nWITHOUT');

/**
 * The first screen signed-out users see: the OGC brand over the Earth at dawn, and the
 * way into the existing registration and sign-in flows. On phones the Earth is larger than
 * the screen and the welcome copy sits over its night side.
 */
export function WelcomeScreen({
  onCreate,
  onSignIn,
}: {
  onCreate: () => void;
  onSignIn: () => void;
}) {
  const { width } = useWindowDimensions();
  return width >= WIDE ? (
    <WideWelcome onCreate={onCreate} onSignIn={onSignIn} />
  ) : (
    <PhoneWelcome onCreate={onCreate} onSignIn={onSignIn} />
  );
}

interface Actions {
  onCreate: () => void;
  onSignIn: () => void;
}

function PhoneWelcome({ onCreate, onSignIn }: Actions) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  // Measured after the first layout; the estimates keep the first frame close.
  const [brandBottom, setBrandBottom] = useState(insets.top + 130);
  const [copyTop, setCopyTop] = useState(height * 0.5);
  const disc = Math.min(width * 1.3, 640);
  const image = disc / DISC;
  const discTop = brandBottom + space[5];
  const titleSize = Math.round(Math.min(44, Math.max(30, width * 0.095)));

  return (
    <View style={styles.root}>
      <Stars width={width} height={height} />
      <ScrollView
        contentContainerStyle={[
          styles.phoneScroll,
          {
            minHeight: height,
            paddingTop: insets.top + space[6],
            paddingBottom: insets.bottom + space[5],
          },
        ]}
      >
        <Globe
          size={image}
          style={{
            position: 'absolute',
            top: discTop - (image * (1 - DISC)) / 2,
            left: (width - image) / 2,
          }}
        />
        <Scrim top={copyTop - 120} width={width} />
        <View
          style={styles.brand}
          onLayout={(event) => {
            const { y, height: h } = event.nativeEvent.layout;
            setBrandBottom(y + h);
          }}
        >
          <OgcLogo height={48} />
          <Text style={styles.tagline}>{TAGLINE_LINES}</Text>
        </View>
        <View style={{ flexGrow: 1, minHeight: disc * 0.34 }} />
        <View
          style={styles.copy}
          onLayout={(event) => {
            setCopyTop(event.nativeEvent.layout.y);
          }}
        >
          <Copy titleSize={titleSize} onCreate={onCreate} onSignIn={onSignIn} />
        </View>
        <Text style={styles.footer}>ONE ID. A WORLD OF POSSIBILITIES.</Text>
      </ScrollView>
      <GoldCurves width={width} />
    </View>
  );
}

function WideWelcome({ onCreate, onSignIn }: Actions) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const globeSize = Math.min(width * 0.48, height * 0.82, 680);
  return (
    <View style={styles.root}>
      <Stars width={width} height={height} />
      <ScrollView
        contentContainerStyle={[
          styles.wideScroll,
          { paddingTop: insets.top + space[5], paddingBottom: insets.bottom + space[6] },
        ]}
      >
        <View style={styles.layoutWide}>
          <View style={styles.columnWide}>
            <View style={[styles.brand, styles.brandWide]}>
              <OgcLogo height={52} />
              <Text style={[styles.tagline, styles.start]}>{TAGLINE_LINES}</Text>
            </View>
            <View style={[styles.copy, styles.copyWide]}>
              <Copy titleSize={56} wide onCreate={onCreate} onSignIn={onSignIn} />
            </View>
            <Text style={[styles.footer, styles.start]}>ONE ID. A WORLD OF POSSIBILITIES.</Text>
          </View>
          <Globe size={globeSize} />
        </View>
      </ScrollView>
      <GoldCurves width={width} />
    </View>
  );
}

function Copy({
  titleSize,
  wide = false,
  onCreate,
  onSignIn,
}: Actions & { titleSize: number; wide?: boolean }) {
  return (
    <>
      <Text style={styles.eyebrow}>WELCOME TO</Text>
      <Text
        style={[
          styles.title,
          wide && styles.start,
          { fontSize: titleSize, lineHeight: Math.round(titleSize * 1.1) },
        ]}
        accessibilityRole="header"
      >
        <Text style={styles.titleBrand}>OGC</Text> Global{'\n'}Communication
      </Text>
      <Text style={[styles.lead, wide && styles.start]}>
        Connect with people, communities and opportunities — anywhere in the world.
      </Text>
      <View style={[styles.actions, wide && styles.actionsWide]}>
        <WelcomeButton title="Create Account" onPress={onCreate} />
        <WelcomeButton title="Sign In" variant="secondary" onPress={onSignIn} />
      </View>
    </>
  );
}

/** The Earth at dawn, fading in; a drawn globe stands in if the image cannot load. */
function Globe({ size, style }: { size: number; style?: StyleProp<ViewStyle> }) {
  const reduced = useReducedMotion();
  const [failed, setFailed] = useState(false);
  const [opacity] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (reduced) {
      opacity.setValue(1);
      return;
    }
    const fade = Animated.timing(opacity, {
      toValue: 1,
      duration: 900,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    fade.start();
    return () => {
      fade.stop();
    };
  }, [opacity, reduced]);

  return (
    <Animated.View
      style={[styles.globe, { width: size, height: size }, style, { opacity }]}
      pointerEvents="none"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      {failed ? (
        <Svg width={size} height={size} viewBox="0 0 100 100">
          <Defs>
            <RadialGradient
              id="globe-fallback"
              cx="50"
              cy="50"
              r="50"
              gradientUnits="userSpaceOnUse"
            >
              <Stop offset="0" stopColor="#0E1C38" />
              <Stop offset="0.76" stopColor="#0B1428" />
              <Stop offset="0.8" stopColor="#4682E6" stopOpacity={0.6} />
              <Stop offset="0.86" stopColor="#4682E6" stopOpacity={0.12} />
              <Stop offset="1" stopColor={color.background} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx="50" cy="50" r="50" fill="url(#globe-fallback)" />
        </Svg>
      ) : (
        <Image
          source={GLOBE}
          style={{ width: size, height: size }}
          resizeMode="contain"
          fadeDuration={0}
          onError={() => {
            setFailed(true);
          }}
        />
      )}
    </Animated.View>
  );
}

/** Darkens the Earth's night side behind the welcome copy so the text stays readable. */
function Scrim({ top, width }: { top: number; width: number }) {
  return (
    <View style={[styles.scrim, { top }]} pointerEvents="none">
      <Svg width={width} height="100%" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id="welcome-scrim" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={color.background} stopOpacity={0} />
            <Stop offset="0.3" stopColor={color.background} stopOpacity={0.45} />
            <Stop offset="0.75" stopColor={color.background} stopOpacity={0.8} />
            <Stop offset="1" stopColor={color.background} stopOpacity={0.92} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#welcome-scrim)" />
      </Svg>
    </View>
  );
}

/** Star positions for a `width` × `height` area, seeded so they never shift between renders. */
function starField(width: number, height: number) {
  let seed = 2026;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  return Array.from({ length: 70 }, () => ({
    x: next() * width,
    y: next() * height,
    r: 0.4 + next() ** 3 * 0.9,
    o: 0.15 + next() * 0.5,
  }));
}

/** A faint, fixed star field behind the Earth. */
function Stars({ width, height }: { width: number; height: number }) {
  const stars = useMemo(() => starField(width, height), [width, height]);
  return (
    <Svg style={StyleSheet.absoluteFill} width={width} height={height} pointerEvents="none">
      {stars.map((s, i) => (
        <Circle key={i} cx={s.x} cy={s.y} r={s.r} fill="#FFFFFF" opacity={s.o} />
      ))}
    </Svg>
  );
}

/** Thin gold light trails sweeping in from the lower corners. */
function GoldCurves({ width }: { width: number }) {
  const h = 200;
  const left = `M -4 ${String(h * 0.05)} Q ${String(width * 0.12)} ${String(h * 0.78)} ${String(width * 0.48)} ${String(h + 6)}`;
  const right = `M ${String(width + 4)} ${String(h * 0.05)} Q ${String(width * 0.88)} ${String(h * 0.78)} ${String(width * 0.52)} ${String(h + 6)}`;
  return (
    <Svg
      style={styles.curves}
      width={width}
      height={h}
      pointerEvents="none"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      <Defs>
        <LinearGradient id="curve-left" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#F0D48B" stopOpacity={0.9} />
          <Stop offset="0.6" stopColor="#E2BB62" stopOpacity={0.45} />
          <Stop offset="1" stopColor="#C99A3C" stopOpacity={0} />
        </LinearGradient>
        <LinearGradient id="curve-right" x1="1" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#F0D48B" stopOpacity={0.9} />
          <Stop offset="0.6" stopColor="#E2BB62" stopOpacity={0.45} />
          <Stop offset="1" stopColor="#C99A3C" stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Path d={left} stroke="url(#curve-left)" strokeWidth={8} opacity={0.12} fill="none" />
      <Path d={right} stroke="url(#curve-right)" strokeWidth={8} opacity={0.12} fill="none" />
      <Path d={left} stroke="url(#curve-left)" strokeWidth={1.4} fill="none" />
      <Path d={right} stroke="url(#curve-right)" strokeWidth={1.4} fill="none" />
    </Svg>
  );
}

/**
 * Account action: gold (primary) or gold-outlined (secondary) pill, with the label centred
 * and an arrow at the trailing edge. Shows pressed, keyboard-focus, disabled and busy states.
 */
function WelcomeButton({
  title,
  onPress,
  variant = 'primary',
  busy = false,
  disabled = false,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary';
  busy?: boolean;
  disabled?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const primary = variant === 'primary';
  const inactive = busy || disabled;
  const tint = primary ? color.onAccent : color.textPrimary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ busy, disabled: inactive }}
      disabled={inactive}
      onPress={onPress}
      onFocus={() => {
        setFocused(true);
      }}
      onBlur={() => {
        setFocused(false);
      }}
      style={({ pressed }) => [
        styles.button,
        primary ? styles.primary : styles.secondary,
        pressed && (primary ? styles.primaryPressed : styles.secondaryPressed),
        focused && styles.focused,
        disabled && !busy && styles.disabled,
      ]}
    >
      {primary ? (
        <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
          <Defs>
            <LinearGradient id="welcome-gold" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#F0D48B" />
              <Stop offset="0.45" stopColor="#E2BB62" />
              <Stop offset="1" stopColor="#C99A3C" />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" fill="url(#welcome-gold)" />
        </Svg>
      ) : null}
      {busy ? (
        <ActivityIndicator color={primary ? color.onAccent : color.accent} />
      ) : (
        <>
          <Text style={[styles.buttonText, { color: tint }]} numberOfLines={1}>
            {title}
          </Text>
          <View style={styles.buttonArrow}>
            <Icon name="arrowRight" size={20} tint={tint} />
          </View>
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.background, overflow: 'hidden' },
  phoneScroll: { flexGrow: 1, alignItems: 'center', paddingHorizontal: space[5] },
  wideScroll: { flexGrow: 1, paddingHorizontal: space[4] },
  layoutWide: {
    flexGrow: 1,
    width: '100%',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[10],
    maxWidth: 1200,
    paddingHorizontal: space[6],
  },
  columnWide: { flex: 1, alignItems: 'flex-start', justifyContent: 'space-between' },
  brand: { alignItems: 'center', gap: space[4] },
  brandWide: { alignItems: 'flex-start' },
  tagline: {
    color: color.textPrimary,
    fontSize: 12.5,
    lineHeight: 19,
    fontWeight: fontWeight.medium,
    letterSpacing: 4.2,
    textAlign: 'center',
    opacity: 0.88,
  },
  globe: { alignItems: 'center', justifyContent: 'center' },
  scrim: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  copy: { width: '100%', maxWidth: 420, alignItems: 'center' },
  copyWide: { alignItems: 'flex-start', marginVertical: space[10] },
  eyebrow: {
    color: color.accent,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    letterSpacing: 5,
    marginBottom: space[3],
  },
  title: {
    color: color.textPrimary,
    fontWeight: fontWeight.medium,
    letterSpacing: -0.6,
    textAlign: 'center',
  },
  titleBrand: { color: color.accent, fontWeight: fontWeight.bold },
  lead: {
    maxWidth: 340,
    marginTop: space[4],
    color: color.textSecondary,
    fontSize: fontSize.md,
    lineHeight: 23,
    textAlign: 'center',
  },
  start: { textAlign: 'left' },
  actions: { width: '100%', maxWidth: 400, gap: space[4], marginTop: space[8] },
  actionsWide: { flexDirection: 'row', maxWidth: 460 },
  button: {
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 56,
    paddingHorizontal: space[12],
    borderRadius: 999,
    overflow: 'hidden',
    borderWidth: 1.5,
  },
  buttonArrow: { position: 'absolute', right: space[6] },
  primary: {
    borderColor: '#F0D48B',
    ...Platform.select({
      ios: {
        shadowColor: color.accent,
        shadowOpacity: 0.35,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 8 },
      },
      default: {},
    }),
  },
  primaryPressed: { opacity: 0.86, transform: [{ translateY: 1 }] },
  secondary: { backgroundColor: 'rgba(11, 11, 13, 0.78)', borderColor: color.accent },
  secondaryPressed: { backgroundColor: color.accentSubtle },
  focused: { borderColor: color.focusRing, borderWidth: 2 },
  disabled: { opacity: 0.45 },
  buttonText: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, letterSpacing: 0.2 },
  footer: {
    marginTop: space[8],
    color: color.textMuted,
    fontSize: 11,
    fontWeight: fontWeight.medium,
    letterSpacing: 3.4,
    textAlign: 'center',
  },
  curves: { position: 'absolute', left: 0, bottom: 0 },
});
