import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useAuth } from '../../auth/AuthProvider';
import { Avatar } from '../../components/identity';
import { Notice } from '../../components/ui';
import { useResource } from '../../lib/use-resource';
import { useMessaging } from '../../messaging/messaging-context';
import { useNavigation } from '../../navigation';
import { Screen } from '../Screen';
import { social } from '../social/styles';
import { m } from './styles';

/** Pick a contact; conversations can be started with contacts only. */
export function NewConversationScreen() {
  const nav = useNavigation();
  const { client } = useAuth();
  const { engine } = useMessaging();
  const load = useCallback(() => client.contacts(), [client]);
  const { state } = useResource(load);
  const [error, setError] = useState<string>();
  const [opening, setOpening] = useState(false);

  return (
    <Screen title="New conversation" onBack={nav.back}>
      {error ? <Notice>{error}</Notice> : null}
      {state.status === 'loading' ? (
        <ActivityIndicator accessibilityLabel="Loading contacts" />
      ) : null}
      {state.status === 'error' ? <Notice>Your contacts could not be loaded.</Notice> : null}
      {state.status === 'ready' && state.data.items.length === 0 ? (
        <Text style={social.empty}>Add contacts from Discover to start messaging them.</Text>
      ) : null}
      {state.status === 'ready'
        ? state.data.items.map((contact) => (
            <Pressable
              key={contact.profile.ogcId}
              style={social.listItem}
              accessibilityRole="button"
              accessibilityLabel={`Message ${contact.profile.displayName}`}
              disabled={opening}
              onPress={() => {
                if (!engine) return;
                setOpening(true);
                engine.openDirect(contact.profile.ogcId).then(
                  (conversation) => {
                    nav.replace({ name: 'conversation', conversationId: conversation.id });
                  },
                  () => {
                    setOpening(false);
                    setError('This conversation could not be opened.');
                  },
                );
              }}
            >
              <Avatar
                url={contact.profile.avatarUrl}
                name={contact.profile.displayName}
                size={40}
              />
              <View style={social.names}>
                <Text style={social.name}>{contact.profile.displayName}</Text>
                <Text style={social.ogcId}>{contact.profile.ogcId}</Text>
              </View>
            </Pressable>
          ))
        : null}
    </Screen>
  );
}

/** Forwarding re-encrypts the message on this device for the chosen conversation. */
export function ForwardScreen({
  conversationId,
  messageId,
}: {
  conversationId: string;
  messageId: string;
}) {
  const nav = useNavigation();
  const { engine, conversations } = useMessaging();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const targets = conversations.filter((c) => c.id !== conversationId && !c.blockedByMe);
  return (
    <Screen
      title="Forward to…"
      subtitle="The recipient sees that it was forwarded, not who wrote it."
      onBack={nav.back}
    >
      {error ? <Notice>{error}</Notice> : null}
      {targets.length === 0 ? <Text style={social.empty}>No other conversations yet.</Text> : null}
      {targets.map((target) => (
        <Pressable
          key={target.id}
          style={social.listItem}
          accessibilityRole="button"
          accessibilityLabel={`Forward to ${target.peer.displayName}`}
          disabled={busy}
          onPress={() => {
            if (!engine) return;
            setBusy(true);
            engine.forward(conversationId, messageId, target.id).then(
              () => {
                nav.back();
              },
              () => {
                setBusy(false);
                setError('The message could not be forwarded.');
              },
            );
          }}
        >
          <Avatar url={target.peer.avatarUrl} name={target.peer.displayName} size={40} />
          <Text style={social.name}>{target.peer.displayName}</Text>
        </Pressable>
      ))}
    </Screen>
  );
}

/** The safety number both people compare to rule out key substitution by the server. */
export function SafetyNumberScreen({ conversationId }: { conversationId: string }) {
  const nav = useNavigation();
  const { engine, conversations } = useMessaging();
  const peer = conversations.find((c) => c.id === conversationId)?.peer;
  const [groups, setGroups] = useState<string[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!engine) return;
    let active = true;
    engine.safetyNumber(conversationId).then(
      (value) => {
        if (active) setGroups(value);
      },
      (cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : 'Unavailable');
      },
    );
    return () => {
      active = false;
    };
  }, [engine, conversationId]);

  return (
    <Screen title="Verify encryption" onBack={nav.back}>
      <Text style={social.body}>
        Compare this number with {peer?.displayName ?? 'them'} in person or on a call. If it matches
        on both devices, your messages are encrypted only for your and their devices. It changes
        when either of you adds or removes a device.
      </Text>
      {error ? <Notice>{error}</Notice> : null}
      {groups ? (
        <View style={m.safety} accessible accessibilityLabel={`Safety number ${groups.join(' ')}`}>
          {groups.map((group, index) => (
            <Text key={index} style={m.safetyGroup}>
              {group}
            </Text>
          ))}
        </View>
      ) : !error ? (
        <ActivityIndicator accessibilityLabel="Computing safety number" />
      ) : null}
    </Screen>
  );
}
