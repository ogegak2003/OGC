import {
  type LocalMessage,
  type MessageDisplayStatus,
  type TimelineEvent,
  attachmentKind,
  conversationAvatar,
  conversationTitle,
  describeEvent,
  mentionsIn,
  messageStatus,
  previewText,
  safeFileName,
  safeMime,
} from '@ogc/messaging';
import {
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
import { color } from '@ogc/ui';
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
import { useAuth } from '../../auth/AuthProvider';
import { Avatar } from '../../components/identity';
import { dayLabel, messageTime, sameDay } from '../../lib/time';
import { communityApi } from '../../api/community';
import { useConversationMessages, useTimeline } from '../../messaging/hooks';
import { useMessaging } from '../../messaging/messaging-context';
import { useNavigation } from '../../navigation';
import { AttachmentView } from './Attachments';
import { m } from './styles';
import { type RecordedVoice, VoiceRecorder } from './VoiceRecorder';

const STATUS: Record<MessageDisplayStatus, { icon: string; label: string }> = {
  PENDING: { icon: '◷', label: 'Sending' },
  SENT: { icon: '✓', label: 'Sent' },
  DELIVERED: { icon: '✓✓', label: 'Delivered' },
  READ: { icon: '✓✓', label: 'Read' },
  FAILED: { icon: '!', label: 'Not sent' },
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

/** A row of the conversation: a message or a group timeline event. */
type Entry = { kind: 'message'; message: LocalMessage } | { kind: 'event'; event: TimelineEvent };

interface PendingAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  uri: string;
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
  const text =
    message.state === 'deleted'
      ? 'This message was deleted'
      : message.state === 'unavailable'
        ? '🔒 Sent before this device joined the conversation, so it can’t be decrypted here.'
        : 'This message couldn’t be decrypted or verified.';
  return <Text style={m.placeholder}>{text}</Text>;
}

function MessageRow({
  message,
  conversation,
  myOgcId,
  replyTarget,
  onActions,
  onReact,
  senderName,
}: {
  message: LocalMessage;
  conversation: ConversationView;
  myOgcId: string;
  replyTarget: LocalMessage | null | undefined;
  onActions: (message: LocalMessage) => void;
  onReact: (message: LocalMessage, reaction: ReactionType, add: boolean) => void;
  /** Groups: who sent it. */
  senderName?: string | undefined;
}) {
  const status = messageStatus(message, conversation);
  const readable = message.state === 'ok' && message.payload !== null;
  const grouped = new Map<ReactionType, { count: number; mine: boolean }>();
  for (const r of message.reactions) {
    const entry = grouped.get(r.reaction) ?? { count: 0, mine: false };
    grouped.set(r.reaction, { count: entry.count + 1, mine: entry.mine || r.ogcId === myOgcId });
  }
  return (
    <View style={message.mine ? m.messageMine : m.messageTheirs}>
      {senderName && !message.mine ? <Text style={m.label}>{senderName}</Text> : null}
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
        style={[m.bubble, message.mine ? m.bubbleMine : m.bubbleTheirs]}
      >
        {message.forwarded ? <Text style={m.label}>Forwarded</Text> : null}
        {message.replyToId ? (
          <Text style={m.quote} numberOfLines={1}>
            {replyTarget ? previewText(replyTarget) : 'Original message unavailable'}
          </Text>
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
          {message.editedAt ? <Text style={m.metaText}>edited ·</Text> : null}
          <Text style={m.metaText}>{messageTime(message.createdAt)}</Text>
          {status ? (
            <Text
              style={status === 'READ' ? m.read : status === 'FAILED' ? m.failed : m.metaText}
              accessibilityLabel={STATUS[status].label}
            >
              {STATUS[status].icon}
            </Text>
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
  const { client } = useAuth();
  const { engine, conversations, typing, presence, connection, setTyping, watchPresence } =
    useMessaging();
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
    ];
    const at = (item: Entry) =>
      item.kind === 'message' ? item.message.createdAt : item.event.createdAt;
    return list.sort((a, b) => at(a).localeCompare(at(b)));
  }, [messages, events]);

  if (!conversation) {
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
          <Text style={m.title}>Conversation</Text>
        </View>
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
        ? 'Online'
        : 'End-to-end encrypted';
  const blocked = conversation.blockedByMe;
  const readOnly = group !== null && !group.canPost;
  const moderator = group !== null && group.myRole !== 'MEMBER' && !group.archived;
  const target = actionsFor;
  const canSubmit =
    !blocked && (text.trim().length > 0 || attachments.length > 0 || voice !== null);

  return (
    <KeyboardAvoidingView style={m.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={m.header}>
        <Text
          style={m.back}
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={nav.back}
        >
          ‹
        </Text>
        <Pressable
          style={m.peer}
          accessibilityRole="button"
          accessibilityLabel={`${title}, ${status}`}
          onPress={() => {
            if (peer) nav.push({ name: 'public-profile', ogcId: peer.ogcId });
            else nav.push({ name: 'group-info', conversationId });
          }}
        >
          <Avatar url={avatar.url} name={avatar.name} size={36} />
          <View style={{ flex: 1 }}>
            <Text style={m.peerName} numberOfLines={1}>
              {title}
            </Text>
            <Text style={typing[conversationId] ? m.rowTyping : m.peerStatus}>{status}</Text>
          </View>
        </Pressable>
        <Text
          style={m.outlinePill}
          accessibilityRole="button"
          onPress={() => {
            if (group) nav.push({ name: 'group-info', conversationId });
            else nav.push({ name: 'safety-number', conversationId });
          }}
        >
          {group ? 'Info' : 'Verify'}
        </Text>
      </View>
      {connection === 'offline' ? (
        <Text style={m.banner} accessibilityRole="alert">
          Offline — reconnecting. Messages are queued on this device.
        </Text>
      ) : null}
      {blocked && peer ? (
        <Text style={m.banner}>
          You blocked {peer.displayName}.{' '}
          <Text
            style={{ color: color.accent }}
            accessibilityRole="button"
            onPress={() => {
              run(client.unblock(peer.ogcId).then(() => engine?.refreshConversations()));
            }}
          >
            Unblock
          </Text>
        </Text>
      ) : null}
      {group?.archived ? (
        <Text style={m.banner}>
          This {group.kind === 'CHANNEL' ? 'channel' : 'group'} is archived and read-only.
        </Text>
      ) : null}

      <FlatList
        ref={list}
        data={items}
        keyExtractor={(item) =>
          item.kind === 'message' ? item.message.clientMessageId : `e-${item.event.id}`
        }
        contentContainerStyle={m.list}
        accessibilityLabel="Messages"
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
        ListEmptyComponent={
          messages ? (
            <View style={m.empty}>
              <Text style={m.emptyTitle}>
                {group ? `Welcome to ${title}` : `Say hello to ${title}`}
              </Text>
              <Text style={[m.note, { textAlign: 'center' }]}>
                {group
                  ? 'Messages are end-to-end encrypted for the members’ devices — not readable by OGC.'
                  : 'Messages are end-to-end encrypted. Only your and their devices can read them — not OGC.'}
              </Text>
            </View>
          ) : null
        }
        renderItem={({ item: entry, index }) => {
          const previousEntry = items[index - 1];
          const at = entry.kind === 'message' ? entry.message.createdAt : entry.event.createdAt;
          const previousAt = previousEntry
            ? previousEntry.kind === 'message'
              ? previousEntry.message.createdAt
              : previousEntry.event.createdAt
            : undefined;
          const day =
            !previousAt || !sameDay(previousAt, at) ? (
              <Text style={m.day}>{dayLabel(at)}</Text>
            ) : null;
          if (entry.kind === 'event') {
            return (
              <>
                {day}
                <Text style={m.day}>
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
        <Text style={[m.banner, { color: color.danger }]} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}

      {readOnly ? (
        <Text style={m.e2ee}>
          {group.archived
            ? 'Nobody can post in an archived group.'
            : group.postPolicy === 'MODERATORS'
              ? 'Only moderators and admins can post here.'
              : 'Only admins can post here.'}
        </Text>
      ) : null}
      <View style={[m.composer, readOnly ? { display: 'none' } : null]}>
        {(editing ?? replyTo) ? (
          <View style={m.context}>
            <Text style={m.contextLabel}>{editing ? 'Editing' : 'Replying to'}</Text>
            <Text style={m.contextText} numberOfLines={1}>
              {previewText(editing ?? replyTo ?? undefined)}
            </Text>
            <Text
              style={m.icon}
              accessibilityRole="button"
              accessibilityLabel={editing ? 'Cancel edit' : 'Cancel reply'}
              onPress={() => {
                if (editing) setText('');
                setEditing(null);
                setReplyTo(null);
              }}
            >
              ✕
            </Text>
          </View>
        ) : null}
        {attachments.map((attachment) => (
          <View key={attachment.id} style={m.chip}>
            <Text style={m.chipText} numberOfLines={1}>
              {safeFileName(attachment.name)}
            </Text>
            <Text
              style={m.icon}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${safeFileName(attachment.name)}`}
              onPress={() => {
                setAttachments((current) => current.filter((a) => a.id !== attachment.id));
              }}
            >
              ✕
            </Text>
          </View>
        ))}
        {voice ? (
          <View style={m.chip}>
            <Text style={m.chipText}>Voice message ready</Text>
            <Text
              style={m.icon}
              accessibilityRole="button"
              accessibilityLabel="Discard voice message"
              onPress={() => {
                setVoice(null);
              }}
            >
              ✕
            </Text>
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
            <Text
              style={m.icon}
              accessibilityRole="button"
              accessibilityLabel="Attach"
              onPress={() => {
                Alert.alert('Attach', undefined, [
                  { text: 'Photo', onPress: () => void pickPhoto() },
                  { text: 'File', onPress: () => void pickFile() },
                  { text: 'Cancel', style: 'cancel' },
                ]);
              }}
            >
              ＋
            </Text>
          ) : null}
          <Text
            style={m.icon}
            accessibilityRole="button"
            accessibilityLabel="Emoji"
            onPress={() => {
              setEmojiOpen((open) => !open);
            }}
          >
            ☺
          </Text>
          <TextInput
            style={m.input}
            multiline
            maxLength={MESSAGE_TEXT_MAX_LENGTH}
            editable={!blocked}
            placeholder={blocked ? 'You can’t send messages here' : 'Encrypted message'}
            placeholderTextColor={color.textDisabled}
            accessibilityLabel="Message"
            value={text}
            onChangeText={changeText}
          />
          {!editing && !canSubmit && !blocked ? (
            <VoiceRecorder onRecorded={setVoice} onError={setError} />
          ) : (
            <Text
              style={[m.send, !canSubmit || busy ? { opacity: 0.5 } : null]}
              accessibilityRole="button"
              accessibilityLabel={editing ? 'Save edit' : 'Send'}
              accessibilityState={{ disabled: !canSubmit || busy }}
              onPress={() => void submit()}
            >
              {editing ? 'Save' : 'Send'}
            </Text>
          )}
        </View>
        <Text style={m.e2ee}>🔒 End-to-end encrypted</Text>
      </View>

      <Modal
        visible={target !== null}
        transparent
        animationType="fade"
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
            <View style={m.sheet} accessibilityViewIsModal>
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
                <Text
                  key={action.label}
                  style={[m.sheetItem, action.danger ? m.danger : null]}
                  accessibilityRole="button"
                  onPress={() => {
                    setActionsFor(null);
                    action.run();
                  }}
                >
                  {action.label}
                </Text>
              ))}
            </View>
          ) : null}
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );

  function sheetActions(
    message: LocalMessage,
  ): { label: string; danger?: boolean; run: () => void }[] {
    if (!engine) return [];
    const actions: { label: string; danger?: boolean; run: () => void }[] = [];
    if (message.state === 'failed') {
      actions.push({
        label: 'Discard',
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
      run: () => {
        setEditing(null);
        setReplyTo(message);
      },
    });
    if (message.mine && readable && message.payload?.text) {
      actions.push({
        label: 'Edit',
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
        run: () => {
          nav.push({ name: 'forward', conversationId, messageId: id });
        },
      });
    }
    actions.push({
      label: 'Delete for me',
      run: () => {
        run(engine.deleteForMe(conversationId, id));
      },
    });
    if (!message.mine) {
      actions.push({
        label: 'Report',
        run: () => {
          nav.push({ name: 'report-message', conversationId, messageId: id });
        },
      });
    }
    if (!message.mine && moderator) {
      actions.push({
        label: 'Remove for everyone',
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
