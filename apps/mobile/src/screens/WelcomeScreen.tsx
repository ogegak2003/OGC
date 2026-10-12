import { color, fontSize, fontWeight, letterSpacing, radius, space } from '@ogc/ui';
import { StyleSheet, Text, View } from 'react-native';
import { Button } from '../components/ui';
import { Screen, text } from './Screen';

export function WelcomeScreen({
  onCreate,
  onSignIn,
}: {
  onCreate: () => void;
  onSignIn: () => void;
}) {
  return (
    <Screen>
      <View style={styles.mark} accessible={false} />
      <Text style={styles.eyebrow}>OBAGAGLOBAL COMMUNICATION</Text>
      <Text style={styles.title} accessibilityRole="header">
        Your identity.{'\n'}
        <Text style={styles.accent}>Not your phone number.</Text>
      </Text>
      <Text style={text.body}>
        Every OGC account gets a permanent OGC ID — a shareable identity that lets people reach you
        without ever seeing your number.
      </Text>
      <View style={styles.actions}>
        <Button title="Create your OGC ID" onPress={onCreate} />
        <Button title="I already have one" variant="secondary" onPress={onSignIn} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  mark: {
    width: 48,
    height: 48,
    borderWidth: 4,
    borderColor: color.accent,
    borderRadius: radius.full,
  },
  eyebrow: {
    color: color.accent,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    letterSpacing: fontSize.xs * letterSpacing.wide * 2,
  },
  title: {
    color: color.textPrimary,
    fontSize: fontSize['4xl'] - 6,
    fontWeight: fontWeight.semibold,
    lineHeight: 42,
  },
  accent: { color: color.accent },
  actions: { gap: space[3], marginTop: space[4] },
});
