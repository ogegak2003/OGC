import { parseInviteToken, parseOgcIdLink } from '@ogc/validation';
import { StatusBar } from 'expo-status-bar';
import { Fragment, type ReactNode, useEffect, useState } from 'react';
import { BackHandler, Linking, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { ApiClient } from './api/client';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { TabShell } from './components/TabBar';
import { Loading } from './components/ui';
import type { MessagingDependencies } from './messaging/messaging-context';
import { MessagingProvider } from './messaging/MessagingProvider';
import { CallScreen } from './screens/calls/CallScreen';
import { CallsScreen } from './screens/calls/CallsScreen';
import { PushNotifications } from './notifications/PushNotifications';
import { NotificationSettingsScreen } from './screens/settings/NotificationSettingsScreen';
import { type Route, StackNavigator } from './navigation';
import { ConversationScreen } from './screens/messaging/ConversationScreen';
import { MessagesScreen } from './screens/messaging/MessagesScreen';
import {
  ForwardScreen,
  NewConversationScreen,
  SafetyNumberScreen,
} from './screens/messaging/OtherScreens';
import {
  ChannelManageScreen,
  ChannelScreen,
  ChannelThreadScreen,
  ChannelsScreen,
  CreateChannelScreen,
  NotificationsScreen,
} from './screens/community/ChannelScreens';
import {
  CreateGroupScreen,
  GroupInfoScreen,
  InvitationsScreen,
  JoinScreen,
  ReportMessageScreen,
} from './screens/community/GroupScreens';
import { CommunitiesScreen } from './screens/community/CommunitiesScreen';
import { HomeScreen } from './screens/HomeScreen';
import { ForgotPasswordScreen } from './screens/ForgotPasswordScreen';
import { RegisterScreen } from './screens/RegisterScreen';
import { SearchScreen } from './screens/SearchScreen';
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
import { SecurityScreen } from './screens/social/SecurityScreen';
import { color, themedStyles } from './theme';
import { ThemeProvider, useTheme } from './theme/ThemeProvider';
import { AppearanceScreen } from './screens/settings/AppearanceScreen';

type GuestRoute =
  | { name: 'welcome' }
  | { name: 'sign-in' }
  | { name: 'register' }
  | { name: 'forgot-password' }
  | { name: 'check-email'; email: string };

/**
 * Listens for OGC identity links (`ogc://id/OGC…`) and invitation links
 * (`…/join#token=ogc_inv_…`). Only a valid public OGC ID or a well-formed
 * invitation token is ever extracted; links open a screen and never add a
 * contact or join anything without the user's tap.
 */
function useIncomingLink(): Route | undefined {
  const [route, setLinkRoute] = useState<Route>();
  useEffect(() => {
    const handle = (url: string | null) => {
      if (!url) return;
      const id = parseOgcIdLink(url);
      if (id) {
        setLinkRoute({ name: 'public-profile', ogcId: id });
        return;
      }
      const token = /\/join[#?]/.test(url) ? parseInviteToken(url) : undefined;
      if (token) setLinkRoute({ name: 'join', token });
    };
    Linking.getInitialURL().then(handle, () => undefined);
    const subscription = Linking.addEventListener('url', ({ url }) => {
      handle(url);
    });
    return () => {
      subscription.remove();
    };
  }, []);
  return route;
}

function renderSignedIn(route: Route) {
  switch (route.name) {
    case 'home':
      return <HomeScreen />;
    case 'communities':
      return <CommunitiesScreen />;
    case 'search':
      return <SearchScreen />;
    case 'security':
      return <SecurityScreen />;
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
      return <ContactsScreen initialTab={route.tab === 'requests' ? 'incoming' : 'contacts'} />;
    case 'privacy':
      return <PrivacyScreen />;
    case 'blocked':
      return <BlockedScreen />;
    case 'report':
      return <ReportScreen ogcId={route.ogcId} />;
    case 'messages':
      return <MessagesScreen />;
    case 'conversation':
      return (
        <ConversationScreen key={route.conversationId} conversationId={route.conversationId} />
      );
    case 'new-conversation':
      return <NewConversationScreen />;
    case 'forward':
      return <ForwardScreen conversationId={route.conversationId} messageId={route.messageId} />;
    case 'safety-number':
      return <SafetyNumberScreen conversationId={route.conversationId} ogcId={route.ogcId} />;
    case 'new-group':
      return <CreateGroupScreen />;
    case 'group-info':
      return <GroupInfoScreen conversationId={route.conversationId} />;
    case 'report-message':
      return (
        <ReportMessageScreen conversationId={route.conversationId} messageId={route.messageId} />
      );
    case 'invitations':
      return <InvitationsScreen />;
    case 'join':
      return <JoinScreen token={route.token} />;
    case 'channels':
      return <ChannelsScreen />;
    case 'new-channel':
      return <CreateChannelScreen />;
    case 'channel':
      return <ChannelScreen key={route.channelId} channelId={route.channelId} />;
    case 'channel-thread':
      return <ChannelThreadScreen channelId={route.channelId} postId={route.postId} />;
    case 'channel-manage':
      return <ChannelManageScreen channelId={route.channelId} />;
    case 'notifications':
      return <NotificationsScreen />;
    case 'calls':
      return <CallsScreen />;
    case 'notification-settings':
      return <NotificationSettingsScreen />;
    case 'appearance':
      return <AppearanceScreen />;
  }
}

/** Rebuilds screens when the theme changes (navigation state lives above, so it survives). */
function Themed({ children }: { children: ReactNode }) {
  const { revision } = useTheme();
  return <Fragment key={revision}>{children}</Fragment>;
}

function Router() {
  const { state } = useAuth();
  const [route, setRoute] = useState<GuestRoute>({ name: 'welcome' });
  const linked = useIncomingLink();
  const signedOut = state.status === 'signed-out';

  // Android back in the signed-out flow returns to the welcome screen.
  useEffect(() => {
    if (!signedOut || route.name === 'welcome') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setRoute({ name: 'welcome' });
      return true;
    });
    return () => {
      subscription.remove();
    };
  }, [signedOut, route.name]);

  if (state.status === 'loading') return <Loading label="Loading" />;
  if (state.status === 'signed-in') {
    if (state.account.accountStatus === 'PENDING_VERIFICATION')
      return (
        <Themed>
          <PendingVerificationScreen />
        </Themed>
      );
    const initial: Route[] = linked ? [{ name: 'home' }, linked] : [{ name: 'home' }];
    // A new link restarts the stack on its screen (the key forces a fresh navigator).
    return (
      <StackNavigator key={linked ? JSON.stringify(linked) : 'home'} initial={initial}>
        {(current) => (
          <>
            <PushNotifications />
            <Themed>
              <TabShell route={current}>{renderSignedIn(current)}</TabShell>
            </Themed>
          </>
        )}
      </StackNavigator>
    );
  }

  const signIn = () => {
    setRoute({ name: 'sign-in' });
  };
  const create = () => {
    setRoute({ name: 'register' });
  };
  const welcome = () => {
    setRoute({ name: 'welcome' });
  };
  return <Themed>{renderGuest()}</Themed>;

  function renderGuest(): ReactNode {
    switch (route.name) {
      case 'welcome':
        return <WelcomeScreen onCreate={create} onSignIn={signIn} />;
      case 'sign-in':
        return (
          <SignInScreen
            onCreate={create}
            onBack={welcome}
            onForgot={() => {
              setRoute({ name: 'forgot-password' });
            }}
          />
        );
      case 'forgot-password':
        return <ForgotPasswordScreen onSignIn={signIn} />;
      case 'register':
        return (
          <RegisterScreen
            onSignIn={signIn}
            onBack={welcome}
            onRegistered={(email) => {
              setRoute({ name: 'check-email', email });
            }}
          />
        );
      case 'check-email':
        return <CheckEmailScreen email={route.email} onSignIn={signIn} />;
    }
  }
}

/** The app frame: background, screens, the call layer and the status bar, in the current theme. */
function Frame() {
  const { mode } = useTheme();
  return (
    <>
      <View style={styles.root}>
        <Router />
        {/* Incoming, outgoing and active calls, over whichever screen is open. */}
        <Themed>
          <CallScreen />
        </Themed>
      </View>
      <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
    </>
  );
}

export function App({
  client,
  messaging,
}: {
  client: ApiClient;
  /** Injected in tests; the real engine, storage and realtime connection by default. */
  messaging?: MessagingDependencies;
}) {
  return (
    <ThemeProvider>
      <SafeAreaProvider style={styles.root}>
        <AuthProvider client={client}>
          <MessagingProvider {...(messaging ? { dependencies: messaging } : {})}>
            <Frame />
          </MessagingProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </ThemeProvider>
  );
}

const styles = themedStyles(() =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: color.background },
  }),
);
