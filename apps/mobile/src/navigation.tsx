import { type ReactNode, createContext, useContext, useEffect, useMemo, useState } from 'react';
import { BackHandler } from 'react-native';

/** Signed-in screens. Parameters carry public identifiers only. */
export type Route =
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
  | { name: 'safety-number'; conversationId: string };

interface Navigation {
  route: Route;
  canGoBack: boolean;
  push: (route: Route) => void;
  /** Replaces the current screen (e.g. "new conversation" → the conversation). */
  replace: (route: Route) => void;
  back: () => void;
}

const NavigationContext = createContext<Navigation | undefined>(undefined);

/**
 * Minimal stack navigation for the signed-in area, with Android hardware-back
 * support. Kept dependency-free for now (see ADR-018); can be swapped for
 * Expo Router without changing screens, which only use `useNavigation()`.
 */
export function StackNavigator({
  initial,
  children,
}: {
  initial: Route[];
  children: (route: Route) => ReactNode;
}) {
  const [stack, setStack] = useState<Route[]>(initial);

  const navigation = useMemo<Navigation>(
    () => ({
      route: stack[stack.length - 1] ?? { name: 'profile' },
      canGoBack: stack.length > 1,
      push: (route) => {
        setStack((s) => [...s, route]);
      },
      replace: (route) => {
        setStack((s) => [...s.slice(0, -1), route]);
      },
      back: () => {
        setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
      },
    }),
    [stack],
  );

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!navigation.canGoBack) return false;
      navigation.back();
      return true;
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
