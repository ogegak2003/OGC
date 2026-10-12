import { color } from '@ogc/ui';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import type { ApiClient } from './api/client';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { HomeScreen } from './screens/HomeScreen';
import { RegisterScreen } from './screens/RegisterScreen';
import { SignInScreen } from './screens/SignInScreen';
import { CheckEmailScreen, PendingVerificationScreen } from './screens/VerificationScreens';
import { WelcomeScreen } from './screens/WelcomeScreen';

type GuestRoute =
  | { name: 'welcome' }
  | { name: 'sign-in' }
  | { name: 'register' }
  | { name: 'check-email'; email: string };

function Router() {
  const { state } = useAuth();
  const [route, setRoute] = useState<GuestRoute>({ name: 'welcome' });

  if (state.status === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={color.accent} accessibilityLabel="Loading" />
      </View>
    );
  }
  if (state.status === 'signed-in') {
    return state.account.accountStatus === 'PENDING_VERIFICATION' ? (
      <PendingVerificationScreen />
    ) : (
      <HomeScreen />
    );
  }

  const signIn = () => {
    setRoute({ name: 'sign-in' });
  };
  const create = () => {
    setRoute({ name: 'register' });
  };
  switch (route.name) {
    case 'welcome':
      return <WelcomeScreen onCreate={create} onSignIn={signIn} />;
    case 'sign-in':
      return <SignInScreen onCreate={create} />;
    case 'register':
      return (
        <RegisterScreen
          onSignIn={signIn}
          onRegistered={(email) => {
            setRoute({ name: 'check-email', email });
          }}
        />
      );
    case 'check-email':
      return <CheckEmailScreen email={route.email} onSignIn={signIn} />;
  }
}

export function App({ client }: { client: ApiClient }) {
  return (
    <AuthProvider client={client}>
      <View style={styles.root}>
        <Router />
      </View>
      <StatusBar style="light" />
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
