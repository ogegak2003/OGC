import { type ReactNode, createContext, useContext, useEffect, useMemo, useState } from 'react';
import { BackHandler } from 'react-native';

/** Signed-in screens. Parameters carry public identifiers only. */
export type Route =
  | { name: 'home' }
  | { name: 'communities' }
  | { name: 'search' }
  | { name: 'security' }
  | { name: 'profile' }
  | { name: 'edit-profile' }
  | { name: 'my-qr' }
  | { name: 'discover' }
  | { name: 'public-profile'; ogcId: string }
  | { name: 'contacts' }
  | { name: 'privacy' }
  | { name: 'blocked' }
  | { name: 'report'; ogcId: string }
  | { name: 'messages' }
  | { name: 'conversation'; conversationId: string }
  | { name: 'new-conversation' }
  | { name: 'forward'; conversationId: string; messageId: string }
  | { name: 'safety-number'; conversationId: string; ogcId?: string }
  | { name: 'new-group' }
  | { name: 'group-info'; conversationId: string }
  | { name: 'report-message'; conversationId: string; messageId: string }
  | { name: 'invitations' }
  | { name: 'join'; token?: string }
  | { name: 'channels' }
  | { name: 'new-channel' }
  | { name: 'channel'; channelId: string }
  | { name: 'channel-thread'; channelId: string; postId: string }
  | { name: 'channel-manage'; channelId: string }
  | { name: 'notifications' }
  | { name: 'calls' }
  | { name: 'notification-settings' };

/** The bottom-navigation destinations, in order. Each is the root of its own stack. */
export const TABS = ['home', 'messages', 'contacts', 'communities', 'profile'] as const;
export type Tab = (typeof TABS)[number];

export function isTab(name: Route['name']): name is Tab {
  return (TABS as readonly string[]).includes(name);
}

interface Navigation {
  route: Route;
  canGoBack: boolean;
  push: (route: Route) => void;
  /** Replaces the current screen (e.g. "new conversation" → the conversation). */
  replace: (route: Route) => void;
  back: () => void;
  /** Switches to a bottom-navigation destination, starting its stack afresh. */
  tab: (tab: Tab) => void;
}

const NavigationContext = createContext<Navigation | undefined>(undefined);

/**
 * Minimal stack navigation for the signed-in area, with bottom-navigation
 * destinations and Android hardware-back support: back pops the stack, then
 * returns from another destination to Home, then leaves the app. Kept
 * dependency-free (see ADR-018); can be swapped for Expo Router without
 * changing screens, which only use `useNavigation()`.
 */
export function StackNavigator({
  initial,
  children,
}: {
  initial: Route[];
  children: (route: Route) => ReactNode;
}) {
  const [stack, setStack] = useState<Route[]>(initial);

  const navigation = useMemo<Navigation>(() => {
    const route = stack[stack.length - 1] ?? { name: 'home' };
    return {
      route,
      canGoBack: stack.length > 1,
      push: (next) => {
        setStack((s) => [...s, next]);
      },
      replace: (next) => {
        setStack((s) => [...s.slice(0, -1), next]);
      },
      back: () => {
        setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
      },
      tab: (tab) => {
        setStack([{ name: tab }]);
      },
    };
  }, [stack]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (navigation.canGoBack) {
        navigation.back();
        return true;
      }
      if (navigation.route.name !== 'home') {
        navigation.tab('home');
        return true;
      }
      return false;
    });
    return () => {
      subscription.remove();
    };
  }, [navigation]);

  return <NavigationContext value={navigation}>{children(navigation.route)}</NavigationContext>;
}

export function useNavigation(): Navigation {
  const value = useContext(NavigationContext);
  if (!value) throw new Error('useNavigation must be used inside <StackNavigator>');
  return value;
}
