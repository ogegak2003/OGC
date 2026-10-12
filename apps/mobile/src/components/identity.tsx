import type { OgcId } from '@ogc/types';
import { color, fontSize, fontWeight, qrSvgPath, radius } from '@ogc/ui';
import { buildOgcIdLink } from '@ogc/validation';
import { useMemo, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useAuth } from '../auth/AuthProvider';

/**
 * QR code for an OGC identity. Encodes only `ogc://id/<OGC ID>` — never tokens,
 * credentials, keys, or private data (ADR-013). Same matrix as the web app.
 */
export function OgcQrCode({ ogcId, size = 220 }: { ogcId: OgcId; size?: number }) {
  const link = buildOgcIdLink(ogcId);
  const { path, size: modules } = useMemo(() => qrSvgPath(link), [link]);
  const quiet = 2;
  const box = modules + quiet * 2;
  return (
    <View
      style={styles.qrFrame}
      accessibilityRole="image"
      accessibilityLabel={`QR code for ${ogcId}`}
      testID="ogc-qr"
      accessibilityHint={link}
    >
      <Svg width={size} height={size} viewBox={`${-quiet} ${-quiet} ${box} ${box}`}>
        {/* Light quiet zone behind the dark modules, for reliable scanning. */}
        <Path d={`M${-quiet} ${-quiet}h${box}v${box}h${-box}z`} fill="#F5F2EA" />
        <Path d={path} fill="#0B0B0A" />
      </Svg>
    </View>
  );
}

/** Profile photo fetched with the session token (so privacy rules apply), with an initials fallback. */
export function Avatar({
  url,
  name,
  size = 48,
}: {
  url: string | null;
  name: string;
  size?: number;
}) {
  const { client } = useAuth();
  const [failed, setFailed] = useState(false);
  const source = client.avatarSource(url);
  const dimension = { width: size, height: size, borderRadius: size / 2 };

  if (source && !failed) {
    return (
      <Image
        source={source}
        style={[styles.avatar, dimension]}
        accessibilityIgnoresInvertColors
        onError={() => {
          setFailed(true);
        }}
      />
    );
  }
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || '·';
  return (
    <View style={[styles.fallback, dimension]} accessible={false}>
      <Text style={[styles.initials, { fontSize: size * 0.38 }]}>{initials}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  qrFrame: {
    alignSelf: 'center',
    padding: 12,
    backgroundColor: color.textPrimary,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.accent,
  },
  avatar: { backgroundColor: color.surfaceRaised, borderWidth: 1, borderColor: color.borderStrong },
  fallback: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surfaceRaised,
    borderWidth: 1,
    borderColor: color.borderStrong,
  },
  initials: { color: color.accent, fontWeight: fontWeight.semibold, fontSize: fontSize.md },
});
