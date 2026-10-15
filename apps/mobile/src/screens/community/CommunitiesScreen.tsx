import type { ChannelView } from '@ogc/types';
import { color, fontSize, fontWeight, radius, space } from '@ogc/ui';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { communityApi } from '../../api/community';
import { useAuth } from '../../auth/AuthProvider';
import { Icon, type IconName } from '../../components/Icon';
import {
  EmptyState,
  IconButton,
  ListGroup,
  Notice,
  SectionHeader,
  SkeletonRows,
} from '../../components/ui';
import { errorMessage } from '../../lib/errors';
import { useMessaging } from '../../messaging/messaging-context';
import { type Route, useNavigation } from '../../navigation';
import { ConversationRow } from '../messaging/MessagesScreen';
import { Screen } from '../Screen';
import { ChannelRow } from './ChannelScreens';

const ACTIONS: { label: string; icon: IconName; route: Route }[] = [
  { label: 'New group', icon: 'community', route: { name: 'new-group' } },
  { label: 'New channel', icon: 'megaphone', route: { name: 'new-channel' } },
  { label: 'Invitations', icon: 'inbox', route: { name: 'invitations' } },
  { label: 'Join with a link', icon: 'link', route: { name: 'join' } },
];

/**
 * Groups (end-to-end encrypted conversations) and community channels (open,
 * moderated feeds — not end-to-end encrypted) in one place.
 */
export function CommunitiesScreen() {
  const nav = useNavigation();
  const { client } = useAuth();
  const api = useMemo(() => communityApi(client), [client]);
  const { conversations, status, invitationsRevision } = useMessaging();
  const [channels, setChannels] = useState<ChannelView[]>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const groups = conversations.filter((c) => c.group !== null);

  useEffect(() => {
    let active = true;
    api.channels.mine().then(
      (list) => {
        if (active) {
          setChannels(list);
          setError(undefined);
        }
      },
      (cause: unknown) => {
        if (active) setError(errorMessage(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [api, attempt, invitationsRevision]);

  return (
    <Screen
      title="Communities"
      subtitle="Private groups and open channels."
      actions={
        <IconButton
          icon="search"
          label="Search channels"
          onPress={() => {
            nav.push({ name: 'channels' });
          }}
        />
      }
    >
      <View style={styles.actions}>
        {ACTIONS.map((action) => (
          <Pressable
            key={action.label}
            accessibilityRole="button"
            onPress={() => {
              nav.push(action.route);
            }}
            style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
          >
            <Icon name={action.icon} size={20} tint={color.accent} />
            <Text style={styles.actionText} numberOfLines={1}>
              {action.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <SectionHeader title="Groups" />
      {status === 'starting' || status === 'idle' ? (
        <View style={styles.surface}>
          <SkeletonRows count={2} label="Loading groups" />
        </View>
      ) : groups.length === 0 ? (
        <View style={styles.surface}>
          <EmptyState
            icon="community"
            title="No groups yet"
            body="Groups are end-to-end encrypted for their members’ devices."
            action={{
              label: 'Create a group',
              icon: 'plus',
              onPress: () => {
                nav.push({ name: 'new-group' });
              },
            }}
          />
        </View>
      ) : (
        <ListGroup>
          {groups.map((conversation) => (
            <ConversationRow key={conversation.id} conversation={conversation} />
          ))}
        </ListGroup>
      )}

      <SectionHeader
        title="Channels"
        action={{
          label: 'Explore',
          onPress: () => {
            nav.push({ name: 'channels' });
          },
        }}
      />
      <View style={styles.note}>
        <Icon name="globe" size={14} tint={color.textMuted} />
        <Text style={styles.noteText}>
          Channels are not end-to-end encrypted: OGC can read posts for moderation and search.
        </Text>
      </View>
      {error ? (
        <Notice
          action={{
            label: 'Retry',
            onPress: () => {
              setAttempt((n) => n + 1);
            },
          }}
        >
          {error}
        </Notice>
      ) : !channels ? (
        <View style={styles.surface}>
          <SkeletonRows count={2} label="Loading channels" />
        </View>
      ) : channels.length === 0 ? (
        <View style={styles.surface}>
          <EmptyState
            icon="hash"
            title="No channels yet"
            body="Follow channels for announcements and discussions from larger communities."
            action={{
              label: 'Explore channels',
              icon: 'search',
              onPress: () => {
                nav.push({ name: 'channels' });
              },
            }}
          />
        </View>
      ) : (
        <ListGroup>
          {channels.map((channel) => (
            <ChannelRow key={channel.id} channel={channel} />
          ))}
        </ListGroup>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
  action: {
    flexGrow: 1,
    flexBasis: '45%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    minHeight: 48,
    paddingHorizontal: space[3],
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.md,
  },
  actionPressed: { backgroundColor: color.surfaceRaised },
  actionText: {
    flex: 1,
    color: color.textPrimary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  surface: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.lg,
  },
  note: { flexDirection: 'row', alignItems: 'flex-start', gap: space[2] },
  noteText: { flex: 1, color: color.textMuted, fontSize: fontSize.xs, lineHeight: 17 },
});
