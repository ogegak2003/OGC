import { type LocalMessage, conversationTitle, previewText } from '@ogc/messaging';
import type { ChannelView, ContactView, PublicProfile } from '@ogc/types';
import { color, fontSize, radius, space } from '@ogc/ui';
import { formatOgcIdForDisplay, ogcIdInputSchema } from '@ogc/validation';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ApiError } from '../api/client';
import { communityApi } from '../api/community';
import { useAuth } from '../auth/AuthProvider';
import { Icon } from '../components/Icon';
import { Avatar } from '../components/identity';
import { EmptyState, ListGroup, ListRow, SectionHeader } from '../components/ui';
import { useMessaging } from '../messaging/messaging-context';
import { useNavigation } from '../navigation';
import { ConversationRow } from './messaging/MessagesScreen';
import { AppBar } from './Screen';
import { ChannelRow } from './community/ChannelScreens';

const LIMIT = 5;

/**
 * One search across chats, contacts and channels, plus an exact OGC ID lookup.
 * Message text is searched on this device only.
 */
export function SearchScreen() {
  const nav = useNavigation();
  const insets = useSafeAreaInsets();
  const { client } = useAuth();
  const api = useMemo(() => communityApi(client), [client]);
  const { conversations, engine } = useMessaging();
  const [query, setQuery] = useState('');
  const [contacts, setContacts] = useState<ContactView[]>([]);
  const [channels, setChannels] = useState<ChannelView[]>([]);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [lookup, setLookup] = useState<{ ogcId: string; result: PublicProfile | 'not-found' }>();
  const trimmed = query.trim();
  const lowered = trimmed.toLocaleLowerCase();
  const parsedId = ogcIdInputSchema.safeParse(trimmed);
  const ogcId = parsedId.success ? parsedId.data : undefined;
  const person = lookup && lookup.ogcId === ogcId ? lookup.result : undefined;

  useEffect(() => {
    let active = true;
    client.contacts().then(
      (page) => {
        if (active) setContacts(page.items);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [client]);

  // Exact OGC ID: look the person up (discovery honours their privacy settings).
  useEffect(() => {
    if (!ogcId) return;
    let active = true;
    client.discover(ogcId).then(
      (profile) => {
        if (active) setLookup({ ogcId, result: profile });
      },
      (error: unknown) => {
        if (active && error instanceof ApiError && error.status === 404)
          setLookup({ ogcId, result: 'not-found' });
      },
    );
    return () => {
      active = false;
    };
  }, [client, ogcId]);

  useEffect(() => {
    if (trimmed.length < 2 || ogcId) return;
    let active = true;
    const timer = setTimeout(() => {
      api.channels.discover(trimmed).then(
        (page) => {
          if (active) setChannels(page.items.slice(0, LIMIT));
        },
        () => undefined,
      );
      void engine?.search(trimmed, LIMIT).then((found) => {
        if (active) setMessages(found);
      });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, engine, trimmed, ogcId]);

  const titleOf = (id: string) => {
    const conversation = conversations.find((c) => c.id === id);
    return conversation ? conversationTitle(conversation) : undefined;
  };
  const searching = trimmed.length >= 2;
  const chatHits = searching
    ? conversations
        .filter((c) => conversationTitle(c).toLocaleLowerCase().includes(lowered))
        .slice(0, LIMIT)
    : [];
  const contactHits = searching
    ? contacts
        .filter(
          (c) =>
            c.profile.displayName.toLocaleLowerCase().includes(lowered) ||
            c.profile.ogcId.toLowerCase().includes(lowered.replace(/\s+/g, '')),
        )
        .slice(0, LIMIT)
    : [];
  const channelHits = searching && !ogcId ? channels : [];
  const messageHits = searching && !ogcId ? messages : [];
  const nothing =
    searching &&
    !ogcId &&
    chatHits.length + contactHits.length + channelHits.length + messageHits.length === 0;

  return (
    <View style={styles.root}>
      <AppBar onBack={nav.back}>
        <View style={styles.searchWrap}>
          <Icon name="search" size={18} tint={color.textMuted} />
          <TextInput
            style={styles.search}
            autoFocus
            placeholder="Search or enter an OGC ID"
            placeholderTextColor={color.textDisabled}
            accessibilityLabel="Search OGC"
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
            autoCapitalize="none"
            selectionColor={color.accent}
            returnKeyType="search"
          />
        </View>
      </AppBar>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space[8] }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {!searching ? (
          <EmptyState
            icon="search"
            title="Search OGC"
            body="Find chats, contacts and channels — or enter an exact OGC ID to look someone up."
          />
        ) : null}

        {ogcId ? (
          <>
            <SectionHeader title="OGC ID" />
            {person && person !== 'not-found' ? (
              <ListGroup>
                <ListRow
                  title={person.displayName}
                  subtitle={formatOgcIdForDisplay(person.ogcId)}
                  leading={<Avatar url={person.avatarUrl} name={person.displayName} size={44} />}
                  onPress={() => {
                    nav.push({ name: 'public-profile', ogcId: person.ogcId });
                  }}
                />
              </ListGroup>
            ) : (
              <Text style={styles.note}>
                {person === 'not-found'
                  ? 'No OGC account was found for that ID.'
                  : `Looking up ${formatOgcIdForDisplay(ogcId)}…`}
              </Text>
            )}
          </>
        ) : null}

        {chatHits.length > 0 ? (
          <>
            <SectionHeader title="Chats" />
            <ListGroup>
              {chatHits.map((conversation) => (
                <ConversationRow key={conversation.id} conversation={conversation} />
              ))}
            </ListGroup>
          </>
        ) : null}

        {contactHits.length > 0 ? (
          <>
            <SectionHeader title="Contacts" />
            <ListGroup>
              {contactHits.map((contact) => (
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
                  onPress={() => {
                    nav.push({ name: 'public-profile', ogcId: contact.profile.ogcId });
                  }}
                />
              ))}
            </ListGroup>
          </>
        ) : null}

        {channelHits.length > 0 ? (
          <>
            <SectionHeader title="Channels" />
            <ListGroup>
              {channelHits.map((channel) => (
                <ChannelRow key={channel.id} channel={channel} />
              ))}
            </ListGroup>
          </>
        ) : null}

        {messageHits.length > 0 ? (
          <>
            <SectionHeader title="Messages on this device" />
            <ListGroup>
              {messageHits.map((message) => (
                <ListRow
                  key={message.clientMessageId}
                  icon="chat"
                  title={message.payload?.text ?? previewText(message)}
                  subtitle={titleOf(message.conversationId)}
                  onPress={() => {
                    nav.push({ name: 'conversation', conversationId: message.conversationId });
                  }}
                />
              ))}
            </ListGroup>
          </>
        ) : null}

        {nothing ? (
          <EmptyState icon="search" title="No results" body={`Nothing matches “${trimmed}”.`} />
        ) : null}

        {searching && !ogcId ? (
          <View style={styles.privacy}>
            <Icon name="lock" size={14} tint={color.textMuted} />
            <Text style={styles.privacyText}>
              Messages are searched on this device only — OGC’s servers can’t read them.
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.background },
  searchWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    minHeight: 42,
    marginRight: space[2],
    paddingHorizontal: space[3],
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.md,
  },
  search: { flex: 1, minHeight: 42, color: color.textPrimary, fontSize: fontSize.md },
  content: { gap: space[4], padding: space[4] },
  note: { color: color.textMuted, fontSize: fontSize.sm },
  privacy: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  privacyText: { flex: 1, color: color.textMuted, fontSize: fontSize.xs, lineHeight: 17 },
});
