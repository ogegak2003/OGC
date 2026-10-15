import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { useNavigation } from '../navigation';
import { forgetPushRegistration, pushSupport, registerForPush } from './push';
import { routeForPush } from './routing';

/** Notifications already opened in this app run. */
const handled = new Set<string>();

// While OGC is open, the app shows new messages and calls itself: no system banner or sound.
if (pushSupport() === 'supported') {
  Notifications.setNotificationHandler({
    handleNotification: () =>
      Promise.resolve({
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
  });
}

/**
 * Push notifications for the signed-in account: registers this device's token (asking for
 * permission once, after sign-in), re-registers when the system rotates the token, and opens
 * the right screen when a notification is tapped — including the one that launched the app.
 * Renders nothing.
 */
export function PushNotifications() {
  const { client, state } = useAuth();
  const nav = useNavigation();
  const account =
    state.status === 'signed-in' && state.account.accountStatus === 'ACTIVE'
      ? state.account.ogcId
      : undefined;

  useEffect(() => {
    if (!account || pushSupport() !== 'supported') return;
    void registerForPush(client, account, { prompt: true });
    const tokens = Notifications.addPushTokenListener(() => {
      forgetPushRegistration(account);
      void registerForPush(client, account, { prompt: false });
    });
    return () => {
      tokens.remove();
      forgetPushRegistration(account);
    };
  }, [client, account]);

  useEffect(() => {
    if (!account || pushSupport() !== 'supported') return;
    const open = (response: Notifications.NotificationResponse | null) => {
      if (!response) return;
      // Each notification opens its screen once (this effect re-subscribes as screens change).
      const id = response.notification.request.identifier;
      if (handled.has(id)) return;
      handled.add(id);
      const destination = routeForPush(response.notification.request.content.data);
      if (!destination) return;
      if ('tab' in destination) nav.tab(destination.tab);
      else nav.push(destination.route);
    };
    // The tap that launched (or resumed) the app, then later taps.
    open(Notifications.getLastNotificationResponse());
    const taps = Notifications.addNotificationResponseReceivedListener(open);
    return () => {
      taps.remove();
    };
  }, [account, nav]);

  return null;
}
