import {
  type LocalMessage,
  type MessageDisplayStatus,
  type PeerKeyStatus,
  type TimelineEvent,
  attachmentKind,
  conversationAvatar,
  conversationTitle,
  callDescription,
  describeEvent,
  mentionsIn,
  messageStatus,
  previewText,
  safeFileName,
  safeMime,
} from '@ogc/messaging';
import {
  type CallView,
  type ConversationView,
  type GroupMemberView,
  REACTION_EMOJI,
  REACTION_TYPES,
  type ReactionType,
} from '@ogc/types';
import {
  ATTACHMENT_MAX_BYTES,
  MESSAGE_TEXT_MAX_LENGTH,
  formatOgcIdForDisplay,
} from '@ogc/validation';
import { color, space } from '@ogc/ui';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../../auth/AuthProvider';
import { Icon, type IconName } from '../../components/Icon';
import { Avatar } from '../../components/identity';
import { IconButton } from '../../components/ui';
import { dayLabel, messageTime, sameDay } from '../../lib/time';
import { useKeyboardVisible } from '../../lib/use-keyboard';
import { communityApi } from '../../api/community';
import {
  useCall,
  useCallHistory,
  useConversationMessages,
  useTimeline,
} from '../../messaging/hooks';
import { useMessaging } from '../../messaging/messaging-context';
import { useNavigation } from '../../navigation';
import { AppBar } from '../Screen';
import { AttachmentView } from './Attachments';
import { m } from './styles';
import { type RecordedVoice, VoiceRecorder } from './VoiceRecorder';

const STATUS: Record<MessageDisplayStatus, { icon: IconName; label: string; tint: string }> = {
  PENDING: { icon: 'clock', label: 'Sending', tint: color.textMuted },
  SENT: { icon: 'check', label: 'Sent', tint: color.textMuted },
  DELIVERED: { icon: 'checkDouble', label: 'Delivered', tint: color.textMuted },
  READ: { icon: 'checkDouble', label: 'Read', tint: color.accent },
  FAILED: { icon: 'alert', label: 'Not sent', tint: color.danger },
};

const EMOJI = [
  '😀',
  '😂',
  '😊',
  '😍',
  '🤔',
  '😮',
  '😢',
  '👍',
  '👏',
  '🙏',
  '🎉',
  '❤️',
  '🔥',
  '✅',
  '👋',
  '🤝',
];

/** Messages from one sender within this window are drawn as one visual group. */
const GROUP_WINDOW_MS = 5 * 60_000;

/** A row of the conversation: a message or a group timeline event. */
type Entry =
  | { kind: 'message'; message: LocalMessage }
  | { kind: 'event'; event: TimelineEvent }
  | { kind: 'call'; call: CallView };

/** When a timeline row happened (sort key and day separators). */
function entryTime(entry: Entry): string {
  if (entry.kind === 'message') return entry.message.createdAt;
  if (entry.kind === 'event') return entry.event.createdAt;
  return entry.call.createdAt;
}

interface PendingAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  uri: string;
}

interface SheetAction {
  label: string;
  icon: IconName;
  danger?: boolean;
  run: () => void;
}

function errorText(error: unknown): string {
  const { code, status } = error as { code?: string; status?: number };
  if (code === 'BLOCKED') return 'Unblock this person to send messages.';
  if (code === 'ARCHIVED') return 'This group is archived and read-only.';
  if (status === 429) return 'You’re sending messages too quickly. They’ll be sent shortly.';
  if (status === 0) return 'You’re offline. Your message will be sent when you reconnect.';
  if (status === 413) return 'That file is too large.';
  return error instanceof Error ? error.message : 'Something went wrong.';
}

function Placeholder({ message }: { message: LocalMessage }) {
  const deleted = message.state === 'deleted';
  const text = deleted
    ? 'This message was deleted'
    : message.state === 'unavailable'
      ? 'Sent before this device joined the conversation, so it can’t be decrypted here.'
      : 'This message couldn’t be decrypted or verified.';
  return (
    <View style={m.placeholderRow}>
      <Icon name={deleted ? 'trash' : 'lock'} size={14} tint={color.textMuted} />
      <Text style={m.placeholder}>{text}</Text>
    </View>
  );
}

function MessageRow({
  message,
  conversation,
  myOgcId,
  replyTarget,
  onActions,
  onReact,
  senderName,
  startsGroup,
  endsGroup,
}: {
  message: LocalMessage;
  conversation: ConversationView;
  myOgcId: string;
  replyTarget: LocalMessage | null | undefined;
  onActions: (message: LocalMessage) => void;
  onReact: (message: LocalMessage, reaction: ReactionType, add: boolean) => void;
  /** Groups: who sent it (shown on the first message of a run). */
  senderName?: string | undefined;
  startsGroup: boolean;
  endsGroup: boolean;
}) {
  const status = messageStatus(message, conversation);
  const readable = message.state === 'ok' && message.payload !== null;
  const grouped = new Map<ReactionType, { count: number; mine: boolean }>();
  for (const r of message.reactions) {
    const entry = grouped.get(r.reaction) ?? { count: 0, mine: false };
    grouped.set(r.reaction, { count: entry.count + 1, mine: entry.mine || r.ogcId === myOgcId });
  }
  return (
    <View
      style={[message.mine ? m.messageMine : m.messageTheirs, startsGroup ? m.spaced : m.grouped]}
    >
      {senderName && !message.mine && startsGroup ? (
        <Text style={m.sender}>{senderName}</Text>
      ) : null}
      <Pressable
        onLongPress={() => {
          onActions(message);
        }}
        accessibilityRole="button"
        accessibilityHint="Long press for message actions"
        accessibilityActions={[{ name: 'longpress', label: 'Message actions' }]}
        onAccessibilityAction={() => {
          onActions(message);
        }}
        style={({ pressed }) => [
          m.bubble,
          message.mine ? m.bubbleMine : m.bubbleTheirs,
          endsGroup && (message.mine ? m.bubbleMineTail : m.bubbleTheirsTail),
          pressed && m.bubblePressed,
        ]}
      >
        {message.forwarded ? (
          <View style={m.labelRow}>
            <Icon name="forward" size={12} tint={color.textMuted} />
            <Text style={m.label}>Forwarded</Text>
          </View>
        ) : null}
        {message.replyToId ? (
          <View style={m.quote}>
            <Text style={m.quoteText} numberOfLines={2}>
              {replyTarget ? previewText(replyTarget) : 'Original message unavailable'}
            </Text>
          </View>
        ) : null}
        {readable ? (
          <>
            {message.payload?.attachments?.map((attachment) => (
              <AttachmentView key={attachment.id} descriptor={attachment} />
            ))}
            {message.payload?.text ? <Text style={m.text}>{message.payload.text}</Text> : null}
          </>
        ) : (
          <Placeholder message={message} />
        )}
        <View style={m.meta}>
          {message.editedAt ? <Text style={m.metaText}>edited</Text> : null}
          <Text style={m.metaText}>{messageTime(message.createdAt)}</Text>
          {status ? (
            <View accessible accessibilityLabel={STATUS[status].label}>
              <Icon
                name={STATUS[status].icon}
                size={14}
                tint={STATUS[status].tint}
                strokeWidth={2}
              />
            </View>
          ) : null}
        </View>
      </Pressable>
      {grouped.size > 0 ? (
        <View style={m.reactions}>
          {[...grouped.entries()].map(([reaction, { count, mine }]) => (
            <Text
              key={reaction}
              style={[m.reaction, mine ? m.reactionMine : null]}
              accessibilityRole="button"
              accessibilityState={{ selected: mine }}
              accessibilityLabel={`${reaction.replace('_', ' ')} reaction, ${String(count)}`}
              onPress={() => {
                onReact(message, reaction, !mine);
              }}
            >
              {REACTION_EMOJI[reaction]} {count > 1 ? count : ''}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** One conversation: messages, actions (long press), and an end-to-end encrypted composer. */
export function ConversationScreen({ conversationId }: { conversationId: string }) {
  const nav = useNavigation();
  const insets = useSafeAreaInsets();
  const keyboardOpen = useKeyboardVisible();
  const { client } = useAuth();
  const { engine, conversations, typing, presence, connection, setTyping, watchPresence, calls } =
    useMessaging();
  const call = useCall();
  const conversation = conversations.find((c) => c.id === conversationId);
  const messages = useConversationMessages(conversationId);
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<LocalMessage | null>(null);
  const [editing, setEditing] = useState<LocalMessage | null>(null);
  const [actionsFor, setActionsFor] = useState<LocalMessage | null>(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [voice, setVoice] = useState<RecordedVoice | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const list = useRef<FlatList<Entry>>(null);
  const typingSince = useRef(0);
  const peerOgcId = conversation?.peer?.ogcId;
  const group = conversation?.group ?? null;
  const events = useTimeline(conversationId);
  const callHistory = useCallHistory(conversationId, Boolean(conversation?.peer));
  const [members, setMembers] = useState<GroupMemberView[]>([]);

  // Groups: the member directory names senders and timeline events.
  const version = conversation?.version;
  useEffect(() => {
    if (!group) return;
    let active = true;
    communityApi(client)
      .groups.members(conversationId)
      .then(
        (list) => {
          if (active) setMembers(list);
        },
        () => undefined,
      );
    return () => {
      active = false;
    };
  }, [client, conversationId, group, version]);

  useEffect(() => {
    if (peerOgcId) watchPresence([peerOgcId]);
  }, [peerOgcId, watchPresence]);

  // Direct conversations: warn when the other person has a device key this device never saw.
  const [keyStatus, setKeyStatus] = useState<PeerKeyStatus | null>(null);
  const [keyCheck, setKeyCheck] = useState(0);
  useEffect(() => {
    if (!engine || !peerOgcId) return;
    let active = true;
    engine.peerKeyStatus(conversationId).then(
      (value) => {
        if (active) setKeyStatus(value);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [engine, peerOgcId, conversationId, version, keyCheck]);

  useEffect(() => {
    if (!engine) return;
    void engine.syncConversation(conversationId).catch(() => undefined);
  }, [engine, conversationId]);

  const newestSeq = messages?.reduce((max, msg) => Math.max(max, msg.seq ?? 0), 0) ?? 0;
  useEffect(() => {
    if (!engine || newestSeq === 0) return;
    void engine.markRead(conversationId).catch(() => undefined);
  }, [engine, conversationId, newestSeq]);

  const byId = useMemo(
    () => new Map((messages ?? []).filter((msg) => msg.id).map((msg) => [msg.id, msg])),
    [messages],
  );
  const names = useMemo(
    () =>
      new Map(
        members.map((member) => [member.profile.ogcId as string, member.profile.displayName]),
      ),
    [members],
  );
  const items = useMemo(() => {
    const list: Entry[] = [
      ...(messages ?? []).map((message) => ({ kind: 'message' as const, message })),
      ...events.map((event) => ({ kind: 'event' as const, event })),
      ...callHistory.map((entry) => ({ kind: 'call' as const, call: entry })),
    ];
    return list.sort((a, b) => entryTime(a).localeCompare(entryTime(b)));
  }, [messages, events, callHistory]);

  if (!conversation) {
    return (
      <View style={m.root}>
        <AppBar title="Conversation" onBack={nav.back} />
        <Text style={m.note}>This conversation isn’t available.</Text>
      </View>
    );
  }

  const run = (task: Promise<unknown>) => {
    setError(undefined);
    task.catch((cause: unknown) => {
      setError(errorText(cause));
    });
  };

  const changeText = (value: string) => {
    setText(value);
    const now = Date.now();
    if (value.trim() && now - typingSince.current > 3_000) {
      typingSince.current = now;
      setTyping(conversationId, true);
    } else if (!value.trim() && typingSince.current) {
      typingSince.current = 0;
      setTyping(conversationId, false);
    }
  };

  const pickPhoto = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.9,
    });
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset) return;
    const mime = asset.mimeType ?? 'image/jpeg';
    addAttachment({
      id: asset.assetId ?? asset.uri,
      name: asset.fileName ?? 'photo.jpg',
      mime,
      size: asset.fileSize ?? 0,
      uri: asset.uri,
    });
  };

  const pickFile = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: false,
    });
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset) return;
    addAttachment({
      id: asset.uri,
      name: asset.name,
      mime: asset.mimeType ?? 'application/octet-stream',
      size: asset.size ?? 0,
      uri: asset.uri,
    });
  };

  const addAttachment = (attachment: PendingAttachment) => {
    const kind = attachmentKind(attachment.mime);
    if (attachment.size > ATTACHMENT_MAX_BYTES[kind]) {
      setError(`${safeFileName(attachment.name)} is too large.`);
      return;
    }
    setAttachments((current) => [...current, attachment].slice(0, 10));
  };

  const submit = async () => {
    if (!engine || busy) return;
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0 && !voice) return;
    setBusy(true);
    setError(undefined);
    try {
      if (editing?.id) {
        await engine.edit(conversationId, editing.id, trimmed);
        setEditing(null);
      } else {
        const uploaded = [];
        for (const attachment of attachments) {
          const bytes = new Uint8Array(await new File(attachment.uri).bytes());
          uploaded.push(
            await engine.uploadAttachment(conversationId, {
              kind: attachmentKind(attachment.mime),
              name: safeFileName(attachment.name),
              mime: safeMime(attachment.mime),
              bytes,
            }),
          );
        }
        if (voice) {
          uploaded.push(
            await engine.uploadAttachment(conversationId, {
              kind: 'VOICE',
              name: 'Voice message',
              mime: voice.mime,
              bytes: voice.bytes,
              durationMs: Math.max(1, voice.durationMs),
            }),
          );
        }
        const reply = replyTo?.id;
        setReplyTo(null);
        // Mentions are found on this device; only the mentioned OGC IDs go to the server.
        const mentions = group
          ? mentionsIn(
              trimmed,
              members
                .filter((member) => member.profile.ogcId !== engine.ogcId)
                .map((member) => ({
                  ogcId: member.profile.ogcId,
                  displayName: member.profile.displayName,
                })),
            )
          : [];
        await engine.send(conversationId, {
          ...(trimmed ? { text: trimmed } : {}),
          ...(uploaded.length ? { attachments: uploaded } : {}),
          ...(reply ? { replyToId: reply } : {}),
          ...(mentions.length ? { mentions } : {}),
        });
      }
      setText('');
      setAttachments([]);
      setVoice(null);
      typingSince.current = 0;
      setTyping(conversationId, false);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const nameOf = (ogcId: string | null): string => {
    if (!ogcId) return 'Someone';
    if (ogcId === engine?.ogcId) return 'You';
    const name = names.get(ogcId);
    if (name !== undefined && name !== '') return name;
    return formatOgcIdForDisplay(ogcId as never);
  };
  const peer = conversation.peer;
  const title = conversationTitle(conversation);
  const avatar = conversationAvatar(conversation);
  const status = typing[conversationId]
    ? 'typing…'
    : group
      ? `${String(group.memberCount)} members · End-to-end encrypted`
      : peer && presence[peer.ogcId] === 'ONLINE'
        ? keyStatus?.state === 'verified'
          ? 'Online · Verified'
          : 'Online'
        : keyStatus?.state === 'verified'
          ? 'End-to-end encrypted · Verified'
          : 'End-to-end encrypted';
  const blocked = conversation.blockedByMe;
  const readOnly = group !== null && !group.canPost;
  const moderator = group !== null && group.myRole !== 'MEMBER' && !group.archived;
  const target = actionsFor;
  const canSubmit =
    !blocked && (text.trim().length > 0 || attachments.length > 0 || voice !== null);

  const at = (entry: Entry | undefined) => (entry ? entryTime(entry) : '');
  /** Same sender, same day, within the grouping window. */
  const continues = (a: Entry | undefined, b: Entry | undefined) =>
    a?.kind === 'message' &&
    b?.kind === 'message' &&
    a.message.senderOgcId === b.message.senderOgcId &&
    a.message.mine === b.message.mine &&
    sameDay(a.message.createdAt, b.message.createdAt) &&
    Math.abs(Date.parse(b.message.createdAt) - Date.parse(a.message.createdAt)) < GROUP_WINDOW_MS;
  const callBusy = call.phase !== 'idle' && call.phase !== 'ended';
  const composerBottom = keyboardOpen ? space[2] : Math.max(insets.bottom, space[2]);

  return (
    <KeyboardAvoidingView style={m.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <AppBar
        onBack={nav.back}
        actions={
          group ? (
            <IconButton
              icon="info"
              label="Info"
              onPress={() => {
                nav.push({ name: 'group-info', conversationId });
              }}
            />
          ) : (
            <View style={m.headerActions}>
              {conversation.peer && !conversation.blockedByMe
                ? (['AUDIO', 'VIDEO'] as const).map((media) => (
                    <IconButton
                      key={media}
                      icon={media === 'VIDEO' ? 'video' : 'phone'}
                      label={`${media === 'VIDEO' ? 'Video' : 'Voice'} call ${title}`}
                      disabled={!calls || connection !== 'online' || callBusy}
                      onPress={() => {
                        if (conversation.peer)
                          void calls?.start(conversationId, media, conversation.peer);
                      }}
                    />
                  ))
                : null}
              <IconButton
                icon="shieldCheck"
                label="Verify"
                onPress={() => {
                  nav.push({ name: 'safety-number', conversationId });
                }}
              />
            </View>
          )
        }
      >
        <Pressable
          style={m.peer}
          accessibilityRole="button"
          accessibilityLabel={`${title}, ${status}`}
          onPress={() => {
            if (peer) nav.push({ name: 'public-profile', ogcId: peer.ogcId });
            else nav.push({ name: 'group-info', conversationId });
          }}
        >
          <Avatar url={avatar.url} name={avatar.name} size={38} />
          <View style={m.peerText}>
            <Text style={m.peerName} numberOfLines={1}>
              {title}
            </Text>
            <View style={m.peerStatusRow}>
              {typing[conversationId] ? null : status === 'Online' ? (
                <View style={[m.recDot, { width: 7, height: 7, backgroundColor: color.success }]} />
              ) : (
                <Icon name="lock" size={11} tint={color.textMuted} />
              )}
              <Text style={typing[conversationId] ? m.rowTyping : m.peerStatus} numberOfLines={1}>
                {status}
              </Text>
            </View>
          </View>
        </Pressable>
      </AppBar>
      {connection === 'offline' ? (
        <View style={m.banner} accessibilityRole="alert">
          <Icon name="offline" size={16} tint={color.warning} />
          <Text style={m.bannerText}>
            Offline — reconnecting. Messages are queued on this device.
          </Text>
        </View>
      ) : null}
      {peer && keyStatus?.state === 'changed' ? (
        <View style={m.banner} accessibilityRole="alert">
          <Icon name="shieldCheck" size={16} tint={color.warning} />
          <Text style={m.bannerText}>
            {peer.displayName}’s security keys changed — they may have signed in on a new device.
            Compare safety numbers again to be sure.
          </Text>
          <Text
            style={m.bannerAction}
            accessibilityRole="button"
            onPress={() => {
              nav.push({ name: 'safety-number', conversationId });
            }}
          >
            Verify
          </Text>
          <Text
            style={m.bannerAction}
            accessibilityRole="button"
            onPress={() => {
              run(
                (engine?.acknowledgePeerKeys(conversationId) ?? Promise.resolve()).then(() => {
                  setKeyCheck((n) => n + 1);
                }),
              );
            }}
          >
            Dismiss
          </Text>
        </View>
      ) : null}
      {blocked && peer ? (
        <View style={m.banner}>
          <Icon name="ban" size={16} tint={color.danger} />
          <Text style={m.bannerText}>You blocked {peer.displayName}.</Text>
          <Text
            style={m.bannerAction}
            accessibilityRole="button"
            onPress={() => {
              run(client.unblock(peer.ogcId).then(() => engine?.refreshConversations()));
            }}
          >
            Unblock
          </Text>
        </View>
      ) : null}
      {group?.archived ? (
        <View style={m.banner}>
          <Icon name="inbox" size={16} tint={color.textSecondary} />
          <Text style={m.bannerText}>
            This {group.kind === 'CHANNEL' ? 'channel' : 'group'} is archived and read-only.
          </Text>
        </View>
      ) : null}

      <FlatList
        ref={list}
        data={items}
        keyExtractor={(item) =>
          item.kind === 'message'
            ? item.message.clientMessageId
            : item.kind === 'event'
              ? `e-${item.event.id}`
              : `c-${item.call.id}`
        }
        contentContainerStyle={m.list}
        accessibilityLabel="Messages"
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
        ListEmptyComponent={
          messages ? (
            <View style={{ alignItems: 'center', gap: space[3], padding: space[8] }}>
              <Avatar url={avatar.url} name={avatar.name} size={72} />
              <Text style={[m.peerName, { fontSize: 20 }]}>
                {group ? `Welcome to ${title}` : `Say hello to ${title}`}
              </Text>
              <View style={m.privacyNote}>
                <Icon name="lock" size={14} tint={color.accent} />
                <Text style={[m.privacyNoteText, { textAlign: 'center' }]}>
                  {group
                    ? 'Messages are end-to-end encrypted for the members’ devices — not readable by OGC.'
                    : 'Messages are end-to-end encrypted. Only your and their devices can read them — not OGC.'}
                </Text>
              </View>
            </View>
          ) : null
        }
        renderItem={({ item: entry, index }) => {
          const previousEntry = items[index - 1];
          const nextEntry = items[index + 1];
          const when = at(entry);
          const previousAt = at(previousEntry);
          const newDay = !previousAt || !sameDay(previousAt, when);
          const day = newDay ? <Text style={m.day}>{dayLabel(when)}</Text> : null;
          if (entry.kind === 'call') {
            const missed =
              entry.call.direction === 'INCOMING' &&
              (entry.call.outcome === 'MISSED' ||
                entry.call.outcome === 'CANCELLED' ||
                entry.call.outcome === 'BUSY');
            return (
              <>
                {day}
                <View style={m.callRow} accessible accessibilityLabel={callDescription(entry.call)}>
                  <Icon
                    name={entry.call.media === 'VIDEO' ? 'video' : 'phone'}
                    size={15}
                    tint={missed ? color.danger : color.textSecondary}
                  />
                  <Text style={[m.callRowText, missed && m.callRowMissed]}>
                    {callDescription(entry.call)}
                  </Text>
                  <Text style={m.callRowTime}>{messageTime(entry.call.createdAt)}</Text>
                </View>
              </>
            );
          }
          if (entry.kind === 'event') {
            return (
              <>
                {day}
                <Text style={m.event}>
                  {describeEvent(entry.event, nameOf, group?.kind ?? 'GROUP')}
                </Text>
              </>
            );
          }
          const item = entry.message;
          return (
            <>
              {day}
              <MessageRow
                message={item}
                senderName={group ? nameOf(item.senderOgcId) : undefined}
                conversation={conversation}
                myOgcId={engine?.ogcId ?? ''}
                replyTarget={item.replyToId ? (byId.get(item.replyToId) ?? null) : undefined}
                startsGroup={newDay || !continues(previousEntry, entry)}
                endsGroup={!continues(entry, nextEntry)}
                onActions={setActionsFor}
                onReact={(message, reaction, add) => {
                  if (engine && message.id)
                    run(engine.react(conversationId, message.id, reaction, add));
                }}
              />
            </>
          );
        }}
      />

      {error ? (
        <View style={[m.banner, { backgroundColor: color.dangerSubtle }]} accessibilityRole="alert">
          <Icon name="alert" size={16} tint={color.danger} />
          <Text style={m.bannerText}>{error}</Text>
        </View>
      ) : null}

      {readOnly ? (
        <View style={[m.readOnly, { paddingBottom: composerBottom + space[2] }]}>
          <Icon name="lock" size={16} tint={color.textMuted} />
          <Text style={m.readOnlyText}>
            {group.archived
              ? 'Nobody can post in an archived group.'
              : group.postPolicy === 'MODERATORS'
                ? 'Only moderators and admins can post here.'
                : 'Only admins can post here.'}
          </Text>
        </View>
      ) : null}
      <View
        style={[
          m.composer,
          { paddingBottom: composerBottom },
          readOnly ? { display: 'none' } : null,
        ]}
      >
        {(editing ?? replyTo) ? (
          <View style={m.context}>
            <Icon name={editing ? 'edit' : 'reply'} size={16} tint={color.accent} />
            <View style={m.contextBody}>
              <Text style={m.contextLabel}>{editing ? 'Editing' : 'Replying to'}</Text>
              <Text style={m.contextText} numberOfLines={1}>
                {previewText(editing ?? replyTo ?? undefined)}
              </Text>
            </View>
            <IconButton
              icon="close"
              label={editing ? 'Cancel edit' : 'Cancel reply'}
              tint={color.textMuted}
              size={18}
              onPress={() => {
                if (editing) setText('');
                setEditing(null);
                setReplyTo(null);
              }}
            />
          </View>
        ) : null}
        {attachments.length > 0 || voice ? (
          <View style={m.chips}>
            {attachments.map((attachment) => (
              <View key={attachment.id} style={m.chip}>
                <Icon
                  name={attachmentKind(attachment.mime) === 'IMAGE' ? 'image' : 'file'}
                  size={14}
                  tint={color.accent}
                />
                <Text style={m.chipText} numberOfLines={1}>
                  {safeFileName(attachment.name)}
                </Text>
                <IconButton
                  icon="close"
                  label={`Remove ${safeFileName(attachment.name)}`}
                  tint={color.textMuted}
                  size={16}
                  onPress={() => {
                    setAttachments((current) => current.filter((a) => a.id !== attachment.id));
                  }}
                />
              </View>
            ))}
            {voice ? (
              <View style={m.chip}>
                <Icon name="mic" size={14} tint={color.accent} />
                <Text style={m.chipText}>Voice message ready</Text>
                <IconButton
                  icon="close"
                  label="Discard voice message"
                  tint={color.textMuted}
                  size={16}
                  onPress={() => {
                    setVoice(null);
                  }}
                />
              </View>
            ) : null}
          </View>
        ) : null}
        {emojiOpen ? (
          <View style={m.emojiGrid}>
            {EMOJI.map((emoji) => (
              <Text
                key={emoji}
                style={m.pick}
                accessibilityRole="button"
                accessibilityLabel={`Insert ${emoji}`}
                onPress={() => {
                  changeText(`${text}${emoji}`);
                  setEmojiOpen(false);
                }}
              >
                {emoji}
              </Text>
            ))}
          </View>
        ) : null}
        <View style={m.composeRow}>
          {!editing && !blocked ? (
            <IconButton
              icon="paperclip"
              label="Attach"
              tint={color.textSecondary}
              onPress={() => {
                Alert.alert('Attach', undefined, [
                  { text: 'Photo', onPress: () => void pickPhoto() },
                  { text: 'File', onPress: () => void pickFile() },
                  { text: 'Cancel', style: 'cancel' },
                ]);
              }}
            />
          ) : null}
          <View style={m.inputWrap}>
            <TextInput
              style={m.input}
              multiline
              maxLength={MESSAGE_TEXT_MAX_LENGTH}
              editable={!blocked}
              placeholder={blocked ? 'You can’t send messages here' : 'Encrypted message'}
              placeholderTextColor={color.textDisabled}
              selectionColor={color.accent}
              accessibilityLabel="Message"
              value={text}
              onChangeText={changeText}
            />
            <IconButton
              icon="smile"
              label="Emoji"
              tint={emojiOpen ? color.accent : color.textMuted}
              size={20}
              onPress={() => {
                setEmojiOpen((open) => !open);
              }}
            />
          </View>
          {!editing && !canSubmit && !blocked ? (
            <VoiceRecorder onRecorded={setVoice} onError={setError} />
          ) : (
            <IconButton
              icon={editing ? 'check' : 'send'}
              label={editing ? 'Save edit' : 'Send'}
              filled
              disabled={!canSubmit || busy}
              size={20}
              onPress={() => void submit()}
            />
          )}
        </View>
        <View style={m.e2ee}>
          <Icon name="lock" size={11} tint={color.textMuted} />
          <Text style={m.e2eeText}>End-to-end encrypted</Text>
        </View>
      </View>

      <Modal
        visible={target !== null}
        transparent
        animationType="fade"
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={() => {
          setActionsFor(null);
        }}
      >
        <Pressable
          style={m.sheetBackdrop}
          accessibilityLabel="Close message actions"
          onPress={() => {
            setActionsFor(null);
          }}
        >
          {target ? (
            <View
              style={[m.sheet, { paddingBottom: Math.max(insets.bottom, space[4]) }]}
              accessibilityViewIsModal
            >
              <View style={m.sheetHandle} />
              {target.id && target.state !== 'deleted' && target.state !== 'failed' ? (
                <View style={m.picks}>
                  {REACTION_TYPES.map((reaction) => (
                    <Text
                      key={reaction}
                      style={m.pick}
                      accessibilityRole="button"
                      accessibilityLabel={`React with ${reaction.replace('_', ' ')}`}
                      onPress={() => {
                        const mine = target.reactions.some(
                          (r) => r.reaction === reaction && r.ogcId === engine?.ogcId,
                        );
                        setActionsFor(null);
                        if (engine && target.id)
                          run(engine.react(conversationId, target.id, reaction, !mine));
                      }}
                    >
                      {REACTION_EMOJI[reaction]}
                    </Text>
                  ))}
                </View>
              ) : null}
              {sheetActions(target).map((action) => (
                <Pressable
                  key={action.label}
                  style={({ pressed }) => [m.sheetItem, pressed && m.sheetItemPressed]}
                  accessibilityRole="button"
                  onPress={() => {
                    setActionsFor(null);
                    action.run();
                  }}
                >
                  <Icon
                    name={action.icon}
                    size={20}
                    tint={action.danger ? color.danger : color.textSecondary}
                  />
                  <Text style={[m.sheetItemText, action.danger ? m.danger : null]}>
                    {action.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );

  function sheetActions(message: LocalMessage): SheetAction[] {
    if (!engine) return [];
    const actions: SheetAction[] = [];
    if (message.state === 'failed') {
      actions.push({
        label: 'Discard',
        icon: 'trash',
        run: () => {
          run(engine.discardFailed(conversationId, message.clientMessageId));
        },
      });
      return actions;
    }
    if (!message.id || message.state === 'deleted' || message.state === 'pending') return actions;
    const id = message.id;
    const readable = message.state === 'ok' && message.payload !== null;
    actions.push({
      label: 'Reply',
      icon: 'reply',
      run: () => {
        setEditing(null);
        setReplyTo(message);
      },
    });
    if (message.mine && readable && message.payload?.text) {
      actions.push({
        label: 'Edit',
        icon: 'edit',
        run: () => {
          setReplyTo(null);
          setEditing(message);
          setText(message.payload?.text ?? '');
        },
      });
    }
    if (readable) {
      actions.push({
        label: 'Forward',
        icon: 'forward',
        run: () => {
          nav.push({ name: 'forward', conversationId, messageId: id });
        },
      });
    }
    actions.push({
      label: 'Delete for me',
      icon: 'trash',
      run: () => {
        run(engine.deleteForMe(conversationId, id));
      },
    });
    if (!message.mine) {
      actions.push({
        label: 'Report',
        icon: 'flag',
        run: () => {
          nav.push({ name: 'report-message', conversationId, messageId: id });
        },
      });
    }
    if (!message.mine && moderator) {
      actions.push({
        label: 'Remove for everyone',
        icon: 'ban',
        danger: true,
        run: () => {
          Alert.alert(
            'Remove for everyone?',
            'The message is erased from OGC and members’ devices. The removal is recorded in the group history, without its content.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Remove',
                style: 'destructive',
                onPress: () => {
                  run(engine.deleteForEveryone(conversationId, id));
                },
              },
            ],
          );
        },
      });
    }
    if (message.mine) {
      actions.push({
        label: 'Delete for everyone',
        icon: 'trash',
        danger: true,
        run: () => {
          Alert.alert(
            'Delete for everyone?',
            'It will be removed from OGC and from both people’s devices. Copies someone already saved or screenshotted can’t be recalled.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Delete',
                style: 'destructive',
                onPress: () => {
                  run(engine.deleteForEveryone(conversationId, id));
                },
              },
            ],
          );
        },
      });
    }
    return actions;
  }
}
