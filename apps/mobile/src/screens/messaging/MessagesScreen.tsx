import {
  type LocalMessage,
  conversationAvatar,
  conversationTitle,
  previewText,
} from '@ogc/messaging';
import type { ConversationView } from '@ogc/types';

import { useEffect, useState } from 'react';
import { FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { Icon } from '../../components/Icon';
import { Avatar, KindAvatar } from '../../components/identity';
import {
  CountBadge,
  EmptyState,
  IconButton,
  Notice,
  SkeletonRows,
  Tabs,
} from '../../components/ui';
import { listTime } from '../../lib/time';
import { useLastMessage } from '../../messaging/hooks';
import { useMessaging } from '../../messaging/messaging-context';
import { useNavigation } from '../../navigation';
import { AppBar } from '../Screen';
import { m } from './styles';
import { color } from '../../theme';

/**
 * One conversation in a list. The preview is the latest message as decrypted
 * on this device — or an honest placeholder when this device cannot read it.
 */
export function ConversationRow({ conversation }: { conversation: ConversationView }) {
  const nav = useNavigation();
  const { typing, presence } = useMessaging();
  const last = useLastMessage(conversation.id);
  const unread = conversation.blockedByMe ? 0 : conversation.unreadCount;
  const online = conversation.peer ? presence[conversation.peer.ogcId] === 'ONLINE' : false;
  const title = conversationTitle(conversation);
  const avatar = conversationAvatar(conversation);
  const group = conversation.group;
  const isTyping = typing[conversation.id] === true;
  const mineLast = last?.mine === true && last.state === 'ok';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}${group ? (group.kind === 'CHANNEL' ? ', channel' : ', group') : ''}${unread ? `, ${String(unread)} unread` : ''}`}
      style={({ pressed }) => [m.row, pressed && m.rowPressed]}
      onPress={() => {
        nav.push({ name: 'conversation', conversationId: conversation.id });
      }}
    >
      <View style={m.avatarWrap}>
        {group ? (
          <KindAvatar
            url={avatar.url}
            name={avatar.name}
            size={50}
            kind={group.kind === 'CHANNEL' ? 'encrypted-channel' : 'group'}
          />
        ) : (
          <Avatar url={avatar.url} name={avatar.name} size={50} />
        )}
        {!group && online ? <View style={m.onlineDot} accessibilityLabel="Online" /> : null}
      </View>
      <View style={m.rowBody}>
        <View style={m.rowTop}>
          <Text style={[m.rowName, unread > 0 && m.rowNameUnread]} numberOfLines={1}>
            {title}
          </Text>
          <Text style={[m.rowTime, unread > 0 && m.rowTimeUnread]}>
            {listTime(last?.createdAt ?? conversation.lastActivityAt)}
          </Text>
        </View>
        <View style={m.rowBottom}>
          {mineLast && !isTyping ? <Text style={m.rowYou}>You: </Text> : null}
          <Text
            style={[
              isTyping ? m.rowTyping : m.rowPreview,
              unread > 0 && !isTyping && m.rowPreviewUnread,
            ]}
            numberOfLines={1}
          >
            {isTyping
              ? 'typing…'
              : conversation.blockedByMe
                ? 'Blocked'
                : group?.archived
                  ? 'Archived'
                  : previewText(last)}
          </Text>
          <CountBadge count={unread} />
        </View>
      </View>
    </Pressable>
  );
}

type Filter = 'all' | 'unread' | 'direct' | 'groups';

const FILTERS: Record<Filter, (c: ConversationView) => boolean> = {
  all: () => true,
  unread: (c) => !c.blockedByMe && c.unreadCount > 0,
  direct: (c) => c.peer !== null,
  groups: (c) => c.group !== null,
};

const FILTER_EMPTY: Record<Filter, string> = {
  all: '',
  unread: 'You’re all caught up.',
  direct: 'No direct chats yet.',
  groups: 'No groups yet.',
};

/** Conversations by recent activity, with filters and on-device search. */
export function MessagesScreen() {
  const nav = useNavigation();
  const { conversations, engine, status, connection, error, retry } = useMessaging();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [results, setResults] = useState<LocalMessage[]>([]);
  const trimmed = query.trim();
  const visibleResults = trimmed.length >= 2 ? results : [];

  useEffect(() => {
    if (!engine || trimmed.length < 2) return;
    let active = true;
    const timer = setTimeout(() => {
      void engine.search(trimmed, 30).then((found) => {
        if (active) setResults(found);
      });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [engine, trimmed]);

  const lowered = trimmed.toLocaleLowerCase();
  const unreadChats = conversations.filter((c) => !c.blockedByMe && c.unreadCount > 0).length;
  const shown = conversations.filter(
    (c) =>
      FILTERS[filter](c) &&
      (!lowered || conversationTitle(c).toLocaleLowerCase().includes(lowered)),
  );

  return (
    <View style={m.root}>
      <AppBar
        title="Chats"
        onBack={nav.canGoBack ? nav.back : undefined}
        actions={
          <>
            <IconButton
              icon="community"
              label="New group"
              onPress={() => {
                nav.push({ name: 'new-group' });
              }}
            />
            <IconButton
              icon="edit"
              label="New message"
              tint={color.accent}
              onPress={() => {
                nav.push({ name: 'new-conversation' });
              }}
            />
          </>
        }
      />
      {connection === 'offline' && status === 'ready' ? (
        <View style={m.banner} accessibilityRole="alert">
          <Icon name="offline" size={16} tint={color.warning} />
          <Text style={m.bannerText}>
            Offline — reconnecting. Messages you send are queued on this device.
          </Text>
        </View>
      ) : null}
      <View style={m.searchWrap}>
        <Icon name="search" size={18} tint={color.textMuted} />
        <TextInput
          style={m.search}
          placeholder="Search chats and messages"
          placeholderTextColor={color.textDisabled}
          accessibilityLabel="Search conversations and messages on this device"
          value={query}
          onChangeText={setQuery}
          autoCorrect={false}
          selectionColor={color.accent}
        />
      </View>
      {conversations.length > 0 ? (
        <View style={m.filters}>
          <Tabs
            options={[
              { id: 'all', label: 'All' },
              { id: 'unread', label: 'Unread', count: unreadChats },
              { id: 'direct', label: 'Direct' },
              { id: 'groups', label: 'Groups' },
            ]}
            value={filter}
            onChange={setFilter}
          />
        </View>
      ) : null}
      {status === 'error' ? (
        <View style={m.padded}>
          <Notice action={{ label: 'Retry', onPress: retry }}>
            Secure messaging could not start on this device. {error}
          </Notice>
        </View>
      ) : null}
      <FlatList
        data={shown}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <ConversationRow conversation={item} />}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={m.listContent}
        ListEmptyComponent={
          status === 'ready' && !trimmed && conversations.length === 0 ? (
            <EmptyState
              icon="chat"
              title="No conversations yet"
              body="Start an end-to-end encrypted conversation with one of your contacts."
              action={{
                label: 'Start a conversation',
                icon: 'edit',
                onPress: () => {
                  nav.push({ name: 'new-conversation' });
                },
              }}
            />
          ) : status === 'starting' ? (
            <SkeletonRows count={5} label="Setting up secure messaging…" />
          ) : status === 'ready' && trimmed ? (
            <Text style={m.note}>No chats match “{trimmed}”.</Text>
          ) : status === 'ready' ? (
            <Text style={m.note}>{FILTER_EMPTY[filter]}</Text>
          ) : null
        }
        ListFooterComponent={
          trimmed.length >= 2 ? (
            <View>
              <Text style={m.sectionLabel}>MESSAGES ON THIS DEVICE</Text>
              {visibleResults.length === 0 ? (
                <Text style={m.note}>No matching messages</Text>
              ) : null}
              {visibleResults.map((message) => (
                <Pressable
                  key={message.clientMessageId}
                  style={({ pressed }) => [m.resultRow, pressed && m.rowPressed]}
                  accessibilityRole="button"
                  onPress={() => {
                    nav.push({ name: 'conversation', conversationId: message.conversationId });
                  }}
                >
                  <Icon name="chat" size={18} tint={color.textMuted} />
                  <Text style={m.resultText} numberOfLines={2}>
                    {message.payload?.text ?? previewText(message)}
                  </Text>
                </Pressable>
              ))}
              <View style={m.privacyNote}>
                <Icon name="lock" size={14} tint={color.textMuted} />
                <Text style={m.privacyNoteText}>
                  Search runs on this device only — OGC’s servers can’t read your messages.
                </Text>
              </View>
            </View>
          ) : null
        }
      />
    </View>
  );
}
