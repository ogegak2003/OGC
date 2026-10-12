import { color } from '@ogc/ui';
import { parseOgcIdLink } from '@ogc/validation';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, View } from 'react-native';
import type { ApiClient } from './api/client';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { type Route, StackNavigator } from './navigation';
import { RegisterScreen } from './screens/RegisterScreen';
import { SignInScreen } from './screens/SignInScreen';
import { CheckEmailScreen, PendingVerificationScreen } from './screens/VerificationScreens';
import { WelcomeScreen } from './screens/WelcomeScreen';
import {
  ContactsScreen,
  DiscoverScreen,
  PublicProfileScreen,
} from './screens/social/PeopleScreens';
import { EditProfileScreen, MyQrScreen, ProfileScreen } from './screens/social/ProfileScreens';
import { BlockedScreen, PrivacyScreen, ReportScreen } from './screens/social/SafetyScreens';

type GuestRoute =
  | { name: 'welcome' }
  | { name: 'sign-in' }
  | { name: 'register' }
  | { name: 'check-email'; email: string };

/**
 * Listens for OGC identity links (`ogc://id/OGC…`). Only a valid public OGC ID
 * is ever extracted; the link opens the profile, never adds a contact.
 */
function useIdentityLink(): string | undefined {
  const [ogcId, setOgcId] = useState<string>();
  useEffect(() => {
    const handle = (url: string | null) => {
      const id = url ? parseOgcIdLink(url) : undefined;
      if (id) setOgcId(id);
    };
    Linking.getInitialURL().then(handle, () => undefined);
    const subscription = Linking.addEventListener('url', ({ url }) => {
      handle(url);
    });
    return () => {
      subscription.remove();
    };
  }, []);
  return ogcId;
}

function renderSignedIn(route: Route) {
  switch (route.name) {
    case 'profile':
      return <ProfileScreen />;
    case 'edit-profile':
      return <EditProfileScreen />;
    case 'my-qr':
      return <MyQrScreen />;
    case 'discover':
      return <DiscoverScreen />;
    case 'public-profile':
      return <PublicProfileScreen ogcId={route.ogcId} />;
    case 'contacts':
      return <ContactsScreen />;
    case 'privacy':
      return <PrivacyScreen />;
    case 'blocked':
      return <BlockedScreen />;
    case 'report':
      return <ReportScreen ogcId={route.ogcId} />;
  }
}

function Router() {
  const { state } = useAuth();
  const [route, setRoute] = useState<GuestRoute>({ name: 'welcome' });
  const linkedOgcId = useIdentityLink();

  if (state.status === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={color.accent} accessibilityLabel="Loading" />
      </View>
    );
  }
  if (state.status === 'signed-in') {
    if (state.account.accountStatus === 'PENDING_VERIFICATION')
      return <PendingVerificationScreen />;
    const initial: Route[] = linkedOgcId
      ? [{ name: 'profile' }, { name: 'public-profile', ogcId: linkedOgcId }]
      : [{ name: 'profile' }];
    // A new link restarts the stack on that profile (the key forces a fresh navigator).
    return (
      <StackNavigator key={linkedOgcId ?? 'home'} initial={initial}>
        {renderSignedIn}
      </StackNavigator>
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
