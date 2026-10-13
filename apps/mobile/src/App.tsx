import { color } from '@ogc/ui';
import { parseInviteToken, parseOgcIdLink } from '@ogc/validation';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, View } from 'react-native';
import type { ApiClient } from './api/client';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import type { MessagingDependencies } from './messaging/messaging-context';
import { MessagingProvider } from './messaging/MessagingProvider';
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
  }
}

function Router() {
  const { state } = useAuth();
  const [route, setRoute] = useState<GuestRoute>({ name: 'welcome' });
  const linked = useIncomingLink();

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
    const initial: Route[] = linked ? [{ name: 'profile' }, linked] : [{ name: 'profile' }];
    // A new link restarts the stack on its screen (the key forces a fresh navigator).
    return (
      <StackNavigator key={linked ? JSON.stringify(linked) : 'home'} initial={initial}>
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

export function App({
  client,
  messaging,
}: {
  client: ApiClient;
  /** Injected in tests; the real engine, storage and realtime connection by default. */
  messaging?: MessagingDependencies;
}) {
  return (
    <AuthProvider client={client}>
      <MessagingProvider {...(messaging ? { dependencies: messaging } : {})}>
        <View style={styles.root}>
          <Router />
        </View>
      </MessagingProvider>
      <StatusBar style="light" />
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
