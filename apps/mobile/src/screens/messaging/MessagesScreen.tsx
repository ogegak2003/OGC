import { type LocalMessage, previewText } from '@ogc/messaging';
import type { ConversationView } from '@ogc/types';
import { color } from '@ogc/ui';
import { useEffect, useState } from 'react';
import { FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { Avatar } from '../../components/identity';
import { listTime } from '../../lib/time';
import { useLastMessage } from '../../messaging/hooks';
import { useMessaging } from '../../messaging/messaging-context';
import { useNavigation } from '../../navigation';
import { m } from './styles';

function ConversationRow({ conversation }: { conversation: ConversationView }) {
  const nav = useNavigation();
  const { typing, presence } = useMessaging();
  const last = useLastMessage(conversation.id);
  const unread = conversation.blockedByMe ? 0 : conversation.unreadCount;
  const online = presence[conversation.peer.ogcId] === 'ONLINE';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${conversation.peer.displayName}${unread ? `, ${String(unread)} unread` : ''}`}
      style={({ pressed }) => [m.row, pressed && { backgroundColor: color.surface }]}
      onPress={() => {
        nav.push({ name: 'conversation', conversationId: conversation.id });
      }}
    >
      <View style={m.avatarWrap}>
        <Avatar url={conversation.peer.avatarUrl} name={conversation.peer.displayName} size={48} />
        {online ? <View style={m.onlineDot} accessibilityLabel="Online" /> : null}
      </View>
      <View style={m.rowBody}>
        <View style={m.rowTop}>
          <Text style={m.rowName} numberOfLines={1}>
            {conversation.peer.displayName}
          </Text>
          <Text style={m.rowTime}>{listTime(last?.createdAt ?? conversation.lastActivityAt)}</Text>
        </View>
        <View style={m.rowBottom}>
          <Text style={typing[conversation.id] ? m.rowTyping : m.rowPreview} numberOfLines={1}>
            {typing[conversation.id]
              ? 'typing…'
              : conversation.blockedByMe
                ? 'Blocked'
                : previewText(last)}
          </Text>
          {unread > 0 ? <Text style={m.unread}>{unread > 999 ? '999+' : unread}</Text> : null}
        </View>
      </View>
    </Pressable>
  );
}

/** Conversations by recent activity, with on-device search. */
export function MessagesScreen() {
  const nav = useNavigation();
  const { conversations, engine, status, connection, error } = useMessaging();
  const [query, setQuery] = useState('');
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
  const shown = lowered
    ? conversations.filter((c) => c.peer.displayName.toLocaleLowerCase().includes(lowered))
    : conversations;

  return (
    <View style={m.root}>
      <View style={m.header}>
        <Text
          style={m.back}
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={nav.back}
        >
          ‹
        </Text>
        <Text style={m.title} accessibilityRole="header">
          Messages
        </Text>
        <Text
          style={m.pill}
          accessibilityRole="button"
          onPress={() => {
            nav.push({ name: 'new-conversation' });
          }}
        >
          New
        </Text>
      </View>
      {connection === 'offline' && status === 'ready' ? (
        <Text style={m.banner} accessibilityRole="alert">
          Offline — reconnecting. Messages you send are queued on this device.
        </Text>
      ) : null}
      <TextInput
        style={m.search}
        placeholder="Search"
        placeholderTextColor={color.textDisabled}
        accessibilityLabel="Search conversations and messages on this device"
        value={query}
        onChangeText={setQuery}
        autoCorrect={false}
      />
      {status === 'error' ? (
        <Text style={m.note} accessibilityRole="alert">
          Secure messaging could not start on this device. {error}
        </Text>
      ) : null}
      <FlatList
        data={shown}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <ConversationRow conversation={item} />}
        ListEmptyComponent={
          status === 'ready' && !trimmed ? (
            <View style={m.empty}>
              <Text style={m.emptyTitle}>No conversations yet</Text>
              <Text style={[m.note, { textAlign: 'center' }]}>
                Start an end-to-end encrypted conversation with one of your contacts.
              </Text>
              <Text
                style={m.pill}
                accessibilityRole="button"
                onPress={() => {
                  nav.push({ name: 'new-conversation' });
                }}
              >
                Start a conversation
              </Text>
            </View>
          ) : status === 'starting' ? (
            <Text style={m.note}>Setting up secure messaging…</Text>
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
                  style={m.row}
                  accessibilityRole="button"
                  onPress={() => {
                    nav.push({ name: 'conversation', conversationId: message.conversationId });
                  }}
                >
                  <Text style={m.rowPreview} numberOfLines={2}>
                    {message.payload?.text ?? previewText(message)}
                  </Text>
                </Pressable>
              ))}
              <Text style={m.note}>
                Search runs on this device only — OGC’s servers can’t read your messages.
              </Text>
            </View>
          ) : null
        }
      />
    </View>
  );
}
