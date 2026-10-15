import { conversationAvatar, conversationTitle } from '@ogc/messaging';
import { color, radius, space } from '@ogc/ui';
import { formatOgcIdForDisplay } from '@ogc/validation';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../auth/AuthProvider';
import { Icon } from '../../components/Icon';
import { Avatar } from '../../components/identity';
import {
  Button,
  EmptyState,
  ListGroup,
  ListRow,
  Loading,
  Notice,
  SkeletonRows,
} from '../../components/ui';
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
  const { state, reload } = useResource(load);
  const [error, setError] = useState<string>();
  const [opening, setOpening] = useState(false);

  return (
    <Screen
      title="New conversation"
      subtitle="Choose a contact. Conversations are end-to-end encrypted."
      onBack={nav.back}
    >
      {error ? <Notice>{error}</Notice> : null}
      {state.status === 'loading' ? (
        <View style={styles.surface}>
          <SkeletonRows count={4} label="Loading contacts" />
        </View>
      ) : null}
      {state.status === 'error' ? (
        <Notice action={{ label: 'Retry', onPress: reload }}>
          Your contacts could not be loaded.
        </Notice>
      ) : null}
      {state.status === 'ready' && state.data.items.length === 0 ? (
        <EmptyState
          icon="contacts"
          title="Add contacts from Discover to start messaging them."
          action={{
            label: 'Find someone',
            icon: 'userPlus',
            onPress: () => {
              nav.push({ name: 'discover' });
            },
          }}
        />
      ) : null}
      {state.status === 'ready' && state.data.items.length > 0 ? (
        <ListGroup>
          {state.data.items.map((contact) => (
            <ListRow
              key={contact.profile.ogcId}
              title={contact.profile.displayName}
              subtitle={formatOgcIdForDisplay(contact.profile.ogcId)}
              leading={
                <Avatar
                  url={contact.profile.avatarUrl}
                  name={contact.profile.displayName}
                  size={44}
                />
              }
              trailing={<Icon name="chat" size={18} tint={color.accent} />}
              chevron={false}
              accessibilityLabel={`Message ${contact.profile.displayName}`}
              onPress={() => {
                if (!engine || opening) return;
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
            />
          ))}
        </ListGroup>
      ) : null}
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
  const targets = conversations.filter(
    (c) => c.id !== conversationId && !c.blockedByMe && (c.group?.canPost ?? true),
  );
  return (
    <Screen
      title="Forward to…"
      subtitle="The recipient sees that it was forwarded, not who wrote it."
      onBack={nav.back}
    >
      {error ? <Notice>{error}</Notice> : null}
      {targets.length === 0 ? (
        <EmptyState icon="forward" title="No other conversations yet." />
      ) : (
        <ListGroup>
          {targets.map((target) => (
            <ListRow
              key={target.id}
              title={conversationTitle(target)}
              leading={
                <Avatar
                  url={conversationAvatar(target).url}
                  name={conversationTitle(target)}
                  size={44}
                />
              }
              trailing={<Icon name="forward" size={18} tint={color.accent} />}
              chevron={false}
              accessibilityLabel={`Forward to ${conversationTitle(target)}`}
              onPress={() => {
                if (!engine || busy) return;
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
            />
          ))}
        </ListGroup>
      )}
    </Screen>
  );
}

/** The safety number both people compare to rule out key substitution by the server. */
export function SafetyNumberScreen({
  conversationId,
  ogcId,
  name,
}: {
  conversationId: string;
  /** Groups: the member to compare with. */
  ogcId?: string | undefined;
  name?: string | undefined;
}) {
  const nav = useNavigation();
  const { engine, conversations } = useMessaging();
  const peer = conversations.find((c) => c.id === conversationId)?.peer;
  const other = name ?? peer?.displayName ?? 'them';
  const [groups, setGroups] = useState<string[]>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const markVerified = () => {
    if (!engine) return;
    setSaving(true);
    engine.markPeerVerified(conversationId).then(nav.back, (cause: unknown) => {
      setSaving(false);
      setError(cause instanceof Error ? cause.message : 'Could not save');
    });
  };

  useEffect(() => {
    if (!engine) return;
    let active = true;
    engine.safetyNumber(conversationId, ogcId).then(
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
  }, [engine, conversationId, ogcId]);

  return (
    <Screen title="Verify encryption" onBack={nav.back}>
      <View style={styles.badge}>
        <Icon name="shieldCheck" size={30} tint={color.accent} />
      </View>
      <Text style={social.body}>
        Compare this number with {other} in person or on a call. If it matches on both devices, your
        messages are encrypted only for your and their devices. It changes when either of you adds
        or removes a device.
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
        <Loading label="Computing safety number" />
      ) : null}
      {groups && !ogcId && peer ? (
        <Button
          title="Numbers match — mark as verified"
          icon="shieldCheck"
          busy={saving}
          onPress={markVerified}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  surface: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.lg,
  },
  badge: {
    alignSelf: 'center',
    width: 64,
    height: 64,
    marginTop: space[2],
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.accentSubtle,
    borderWidth: 1,
    borderColor: color.accentBorder,
    borderRadius: radius.xl,
  },
});
