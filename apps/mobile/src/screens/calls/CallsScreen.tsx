import { callDescription, conversationTitle, isMissedCall } from '@ogc/messaging';
import type { ConversationView } from '@ogc/types';
import { fontSize, space } from '@ogc/ui';
import { formatOgcIdForDisplay } from '@ogc/validation';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Icon } from '../../components/Icon';
import { Avatar } from '../../components/identity';
import {
  EmptyState,
  IconButton,
  ListGroup,
  ListRow,
  Notice,
  SkeletonRows,
  Tabs,
} from '../../components/ui';
import { listTime } from '../../lib/time';
import { useCall, useRecentCalls } from '../../messaging/hooks';
import { useMessaging } from '../../messaging/messaging-context';
import { useNavigation } from '../../navigation';
import { Screen } from '../Screen';
import { color, themedStyles } from '../../theme';

/** Voice and video call buttons for a direct conversation. */
function CallActions({ conversation, name }: { conversation: ConversationView; name: string }) {
  const { calls, connection } = useMessaging();
  const call = useCall();
  const busy = call.phase !== 'idle' && call.phase !== 'ended';
  const peer = conversation.peer;
  if (!peer || conversation.blockedByMe) return null;
  return (
    <View style={styles.actions}>
      {(['AUDIO', 'VIDEO'] as const).map((media) => (
        <IconButton
          key={media}
          icon={media === 'VIDEO' ? 'video' : 'phone'}
          label={`${media === 'VIDEO' ? 'Video' : 'Voice'} call ${name}`}
          tint={color.accent}
          disabled={!calls || connection !== 'online' || busy}
          onPress={() => {
            void calls?.start(conversation.id, media, peer);
          }}
        />
      ))}
    </View>
  );
}

/** Recent calls (with call-back) and the people you can call. */
export function CallsScreen() {
  const nav = useNavigation();
  const { conversations, presence, watchPresence, status } = useMessaging();
  const { calls, failed } = useRecentCalls();
  const { supported } = useCall();
  const callable = useMemo(
    () => conversations.filter((c) => c.peer !== null && !c.blockedByMe),
    [conversations],
  );
  const byId = useMemo(() => new Map(conversations.map((c) => [c.id, c])), [conversations]);
  const [filter, setFilter] = useState<'all' | 'missed'>('all');
  const missed = calls?.filter(isMissedCall) ?? [];
  const shown = filter === 'missed' ? missed : calls;

  useEffect(() => {
    const ogcIds = callable.flatMap((c) => (c.peer ? [c.peer.ogcId] : []));
    if (ogcIds.length > 0) watchPresence(ogcIds.slice(0, 100));
  }, [callable, watchPresence]);

  return (
    <Screen
      title="Calls"
      subtitle="One-to-one voice and video calls with the people you chat with."
      onBack={nav.back}
    >
      <Text style={styles.heading} accessibilityRole="header">
        Recent calls
      </Text>
      {calls?.length ? (
        <Tabs
          options={[
            { id: 'all', label: 'All' },
            { id: 'missed', label: 'Missed', count: missed.length },
          ]}
          value={filter}
          onChange={setFilter}
        />
      ) : null}
      {failed ? (
        <Notice>Your call history could not be loaded.</Notice>
      ) : calls === undefined ? (
        <View style={styles.surface}>
          <SkeletonRows count={3} label="Loading your calls" />
        </View>
      ) : calls.length === 0 ? (
        <EmptyState icon="phone" title="No calls yet" body="Start one below or from a chat." />
      ) : shown?.length === 0 ? (
        <EmptyState icon="phone" title="No missed calls" />
      ) : (
        <ListGroup>
          {shown?.map((call) => {
            const conversation = byId.get(call.conversationId);
            const name = call.peer.displayName || formatOgcIdForDisplay(call.peer.ogcId);
            return (
              <ListRow
                key={call.id}
                title={name}
                subtitle={`${callDescription(call)} · ${listTime(call.createdAt)}`}
                tone={isMissedCall(call) ? 'danger' : 'default'}
                leading={<Avatar url={call.peer.avatarUrl} name={name} size={44} />}
                trailing={
                  conversation ? <CallActions conversation={conversation} name={name} /> : null
                }
                chevron={false}
                onPress={() => {
                  nav.push({ name: 'conversation', conversationId: call.conversationId });
                }}
              />
            );
          })}
        </ListGroup>
      )}

      <Text style={styles.heading} accessibilityRole="header">
        Start a call
      </Text>
      {status !== 'ready' ? (
        <View style={styles.surface}>
          <SkeletonRows count={2} label="Loading your conversations" />
        </View>
      ) : callable.length === 0 ? (
        <EmptyState
          icon="contacts"
          title="Calls are with people you chat with"
          body="Find someone by their OGC ID and start a conversation first."
          action={{
            label: 'Find someone',
            icon: 'userPlus',
            onPress: () => {
              nav.push({ name: 'discover' });
            },
          }}
        />
      ) : (
        <ListGroup>
          {callable.map((conversation) => {
            const peer = conversation.peer;
            if (!peer) return null;
            const name = conversationTitle(conversation);
            const online = presence[peer.ogcId] === 'ONLINE';
            return (
              <ListRow
                key={conversation.id}
                title={name}
                subtitle={online ? 'Online' : 'Not online now'}
                leading={
                  <View>
                    <Avatar url={peer.avatarUrl} name={name} size={44} />
                    {online ? <View style={styles.onlineDot} /> : null}
                  </View>
                }
                trailing={<CallActions conversation={conversation} name={name} />}
                chevron={false}
                onPress={() => {
                  nav.push({ name: 'conversation', conversationId: conversation.id });
                }}
              />
            );
          })}
        </ListGroup>
      )}
      {supported ? null : (
        <View style={styles.note}>
          <Icon name="info" size={16} tint={color.textMuted} />
          <Text style={styles.noteText}>
            Calls need the OGC app build; they aren’t available in Expo Go.
          </Text>
        </View>
      )}
    </Screen>
  );
}

const styles = themedStyles(() =>
  StyleSheet.create({
    heading: { color: color.textPrimary, fontSize: fontSize.lg, fontWeight: '600' },
    surface: {
      backgroundColor: color.surface,
      borderWidth: 1,
      borderColor: color.border,
      borderRadius: 16,
    },
    actions: { flexDirection: 'row' },
    onlineDot: {
      position: 'absolute',
      right: 0,
      bottom: 0,
      width: 12,
      height: 12,
      borderRadius: 6,
      borderWidth: 2,
      borderColor: color.surface,
      backgroundColor: color.success,
    },
    note: { flexDirection: 'row', gap: space[2], alignItems: 'center' },
    noteText: { flex: 1, color: color.textMuted, fontSize: fontSize.xs },
  }),
);
