import type {
  ContactView,
  CreatedInviteLink,
  GroupMemberView,
  InvitePreview,
  NotificationPreferences,
  ReceivedInvitationView,
  ReportCategory,
} from '@ogc/types';
import { color } from '@ogc/ui';
import {
  COMMUNITY_NAME_MAX_LENGTH,
  GROUP_MEMBER_LIMIT,
  buildInviteUrl,
  canActOnMember,
  canAssignRole,
  canEditDetails,
  canInvite,
  canManageInviteLinks,
  parseInviteToken,
} from '@ogc/validation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, Share, Switch, Text, View } from 'react-native';
import { communityApi } from '../../api/community';
import { webAppUrl } from '../../config/runtime';
import { useAuth } from '../../auth/AuthProvider';
import { Avatar, LinkQrCode } from '../../components/identity';
import { Button, Field, Notice } from '../../components/ui';
import { errorMessage } from '../../lib/errors';
import { useResource } from '../../lib/use-resource';
import { useMessaging } from '../../messaging/messaging-context';
import { useNavigation } from '../../navigation';
import { Screen } from '../Screen';
import { social } from '../social/styles';

const ROLE_LABEL = { OWNER: 'Owner', ADMIN: 'Admin', MODERATOR: 'Moderator', MEMBER: 'Member' };

function useCommunity() {
  const { client } = useAuth();
  return useMemo(() => communityApi(client), [client]);
}

/** Creates a group or encrypted channel and invites contacts (they join after accepting). */
export function CreateGroupScreen() {
  const nav = useNavigation();
  const { client } = useAuth();
  const api = useCommunity();
  const { engine } = useMessaging();
  const load = useCallback(() => client.contacts(), [client]);
  const { state } = useResource(load);
  const [kind, setKind] = useState<'GROUP' | 'CHANNEL'>('GROUP');
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  return (
    <Screen
      title={kind === 'GROUP' ? 'New group' : 'New encrypted channel'}
      subtitle="End-to-end encrypted. Invited people join after they accept."
      onBack={nav.back}
    >
      <View style={social.tabs}>
        {(['GROUP', 'CHANNEL'] as const).map((value) => (
          <Pressable
            key={value}
            accessibilityRole="tab"
            accessibilityState={{ selected: kind === value }}
            style={[social.tab, kind === value && social.tabActive]}
            onPress={() => {
              setKind(value);
            }}
          >
            <Text style={[social.tabText, kind === value && social.tabTextActive]}>
              {value === 'GROUP' ? 'Group' : 'Encrypted channel'}
            </Text>
          </Pressable>
        ))}
      </View>
      <Text style={social.muted}>
        {kind === 'GROUP'
          ? `Up to ${String(GROUP_MEMBER_LIMIT)} people; everyone can post.`
          : 'Up to 32 people; admins post, members read and react.'}{' '}
        The name and member list are visible to OGC; messages are not.
      </Text>
      <Field
        label="Name"
        value={name}
        maxLength={COMMUNITY_NAME_MAX_LENGTH}
        onChangeText={setName}
      />
      <Text style={social.label}>Invite contacts ({selected.size})</Text>
      {state.status === 'loading' ? (
        <ActivityIndicator accessibilityLabel="Loading contacts" />
      ) : null}
      {state.status === 'ready'
        ? state.data.items.map((contact: ContactView) => {
            const on = selected.has(contact.profile.ogcId);
            return (
              <Pressable
                key={contact.profile.ogcId}
                style={social.listItem}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={contact.profile.displayName}
                onPress={() => {
                  setSelected((current) => {
                    const next = new Set(current);
                    if (next.has(contact.profile.ogcId)) next.delete(contact.profile.ogcId);
                    else if (next.size < GROUP_MEMBER_LIMIT - 1) next.add(contact.profile.ogcId);
                    return next;
                  });
                }}
              >
                <Avatar
                  url={contact.profile.avatarUrl}
                  name={contact.profile.displayName}
                  size={36}
                />
                <Text style={[social.name, { flex: 1 }]}>{contact.profile.displayName}</Text>
                <Text style={{ color: on ? color.accent : color.textDisabled }}>
                  {on ? '✓' : '○'}
                </Text>
              </Pressable>
            );
          })
        : null}
      {error ? <Notice>{error}</Notice> : null}
      <Button
        title="Create"
        busy={busy}
        onPress={() => {
          if (!name.trim()) {
            setError('Give it a name.');
            return;
          }
          setBusy(true);
          setError(undefined);
          api.groups
            .create({
              kind,
              name: name.trim(),
              ...(selected.size ? { invite: [...selected] } : {}),
            })
            .then(
              async ({ conversation }) => {
                await engine?.refreshConversations().catch(() => undefined);
                nav.replace({ name: 'conversation', conversationId: conversation.id });
              },
              (cause: unknown) => {
                setBusy(false);
                setError(errorMessage(cause));
              },
            );
        }}
      />
    </Screen>
  );
}

/** Group or encrypted-channel details and management, shown according to the viewer's role. */
export function GroupInfoScreen({ conversationId }: { conversationId: string }) {
  const nav = useNavigation();
  const api = useCommunity();
  const { client } = useAuth();
  const { engine, conversations } = useMessaging();
  const conversation = conversations.find((c) => c.id === conversationId);
  const group = conversation?.group;
  const [members, setMembers] = useState<GroupMemberView[]>([]);
  const [preferences, setPreferences] = useState<NotificationPreferences>();
  const [link, setLink] = useState<CreatedInviteLink>();
  const [contacts, setContacts] = useState<ContactView[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    Promise.all([api.groups.members(conversationId), api.groups.preferences(conversationId)]).then(
      ([list, prefs]) => {
        if (!active) return;
        setMembers(list);
        setPreferences(prefs);
      },
      (cause: unknown) => {
        if (active) setError(errorMessage(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [api, conversationId, reload]);

  if (!group) {
    return (
      <Screen title="Group" onBack={nav.back}>
        <Notice>This group isn’t available.</Notice>
      </Screen>
    );
  }
  const role = group.myRole;
  const kind = group.kind;
  const noun = kind === 'CHANNEL' ? 'channel' : 'group';
  const run = (task: Promise<unknown>, success?: string) => {
    setError(undefined);
    setNotice(undefined);
    task.then(
      async () => {
        if (success) setNotice(success);
        setReload((n) => n + 1);
        await engine?.refreshConversations().catch(() => undefined);
      },
      (cause: unknown) => {
        setError(errorMessage(cause));
      },
    );
  };
  const confirm = (title: string, message: string, action: string, onConfirm: () => void) => {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: action, style: 'destructive', onPress: onConfirm },
    ]);
  };
  const leaveOrDelete = (task: Promise<unknown>) => {
    task.then(
      async () => {
        await engine?.forgetConversation(conversationId);
        nav.replace({ name: 'messages' });
      },
      (cause: unknown) => {
        setError(errorMessage(cause));
      },
    );
  };
  const memberIds = new Set(members.map((member) => member.profile.ogcId as string));

  return (
    <Screen
      title={group.name}
      subtitle={`${String(group.memberCount)} members · End-to-end encrypted`}
      onBack={nav.back}
    >
      {group.description ? <Text style={social.body}>{group.description}</Text> : null}
      {error ? <Notice>{error}</Notice> : null}
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      <Text style={social.label}>NOTIFICATIONS</Text>
      <View style={social.tabs}>
        {(['ALL', 'MENTIONS', 'NONE'] as const).map((level) => (
          <Pressable
            key={level}
            accessibilityRole="tab"
            accessibilityState={{ selected: preferences?.level === level }}
            style={[social.tab, preferences?.level === level && social.tabActive]}
            onPress={() => {
              api.groups
                .setPreferences(conversationId, { level })
                .then(setPreferences, (cause: unknown) => {
                  setError(errorMessage(cause));
                });
            }}
          >
            <Text style={[social.tabText, preferences?.level === level && social.tabTextActive]}>
              {level === 'ALL' ? 'All' : level === 'MENTIONS' ? 'Mentions' : 'Off'}
            </Text>
          </Pressable>
        ))}
      </View>

      <Text style={social.label}>MEMBERS</Text>
      {members.map((member) => {
        const self = member.profile.ogcId === engine?.ogcId;
        const actions: { text: string; onPress: () => void; style?: 'destructive' }[] = [];
        if (!self) {
          actions.push({
            text: 'Verify safety number',
            onPress: () => {
              nav.push({ name: 'safety-number', conversationId, ogcId: member.profile.ogcId });
            },
          });
        }
        if (
          !group.archived &&
          !self &&
          member.role !== 'ADMIN' &&
          canAssignRole(role, member.role, 'ADMIN', kind, false)
        ) {
          actions.push({
            text: 'Make admin',
            onPress: () => {
              run(api.groups.setRole(conversationId, member.profile.ogcId, 'ADMIN'));
            },
          });
        }
        if (
          !group.archived &&
          !self &&
          member.role === 'ADMIN' &&
          canAssignRole(role, member.role, 'MEMBER', kind, false)
        ) {
          actions.push({
            text: 'Remove admin',
            onPress: () => {
              run(api.groups.setRole(conversationId, member.profile.ogcId, 'MEMBER'));
            },
          });
        }
        if (role === 'OWNER' && !self) {
          actions.push({
            text: 'Make owner',
            onPress: () => {
              confirm(
                'Transfer ownership?',
                `${member.profile.displayName} becomes the owner; you become an admin.`,
                'Transfer',
                () => {
                  run(
                    api.groups.transfer(conversationId, member.profile.ogcId),
                    'Ownership transferred.',
                  );
                },
              );
            },
          });
        }
        if (!self && canActOnMember(role, member.role, kind)) {
          actions.push({
            text: 'Remove',
            style: 'destructive',
            onPress: () => {
              confirm(
                `Remove ${member.profile.displayName}?`,
                'Their devices are removed from the encryption group, so they can’t read anything sent afterwards.',
                'Remove',
                () => {
                  run(api.groups.removeMember(conversationId, member.profile.ogcId));
                },
              );
            },
          });
        }
        return (
          <Pressable
            key={member.profile.ogcId}
            style={social.listItem}
            accessibilityRole="button"
            accessibilityLabel={`${member.profile.displayName}, ${ROLE_LABEL[member.role]}`}
            disabled={actions.length === 0}
            onPress={() => {
              Alert.alert(member.profile.displayName, ROLE_LABEL[member.role], [
                ...actions,
                { text: 'Close', style: 'cancel' },
              ]);
            }}
          >
            <Avatar url={member.profile.avatarUrl} name={member.profile.displayName} size={36} />
            <Text style={[social.name, { flex: 1 }]}>
              {member.profile.displayName}
              {self ? ' (you)' : ''}
            </Text>
            <Text style={social.badge}>{ROLE_LABEL[member.role]}</Text>
          </Pressable>
        );
      })}

      {canInvite(role, group.invitePolicy) && !group.archived ? (
        <>
          <Text style={social.label}>INVITE CONTACTS</Text>
          {contacts === undefined ? (
            <Button
              title="Choose contacts"
              variant="secondary"
              onPress={() => {
                client.contacts().then(
                  (page) => {
                    setContacts(page.items);
                  },
                  (cause: unknown) => {
                    setError(errorMessage(cause));
                  },
                );
              }}
            />
          ) : (
            contacts
              .filter((contact) => !memberIds.has(contact.profile.ogcId))
              .map((contact) => (
                <Pressable
                  key={contact.profile.ogcId}
                  style={social.listItem}
                  accessibilityRole="button"
                  accessibilityLabel={`Invite ${contact.profile.displayName}`}
                  onPress={() => {
                    run(
                      api.groups.invite(conversationId, [contact.profile.ogcId]),
                      `Invitation sent to ${contact.profile.displayName}.`,
                    );
                  }}
                >
                  <Avatar
                    url={contact.profile.avatarUrl}
                    name={contact.profile.displayName}
                    size={32}
                  />
                  <Text style={[social.name, { flex: 1 }]}>{contact.profile.displayName}</Text>
                  <Text style={{ color: color.accent }}>Invite</Text>
                </Pressable>
              ))
          )}
        </>
      ) : null}

      {canManageInviteLinks(role) && !group.archived ? (
        <>
          <Text style={social.label}>INVITATION LINK</Text>
          {link ? (
            <>
              <Text style={social.muted}>
                Share it now — OGC keeps only a hash and can’t show it again. It expires in 7 days.
              </Text>
              <LinkQrCode
                payload={buildInviteUrl(webAppUrl, link.token)}
                label={`Invitation QR code for ${group.name}`}
              />
              <Button
                title="Share link"
                onPress={() => {
                  void Share.share({
                    title: `Join ${group.name} on OGC`,
                    message: buildInviteUrl(webAppUrl, link.token),
                  });
                }}
              />
              <Button
                title="Revoke this link"
                variant="ghost"
                onPress={() => {
                  run(api.links.revoke(link.id), 'Link revoked.');
                  setLink(undefined);
                }}
              />
            </>
          ) : (
            <Button
              title="Create invitation link"
              variant="secondary"
              onPress={() => {
                api.links
                  .create({ groupId: conversationId }, { expiresInHours: 7 * 24 })
                  .then(setLink, (cause: unknown) => {
                    setError(errorMessage(cause));
                  });
              }}
            />
          )}
        </>
      ) : null}

      {canEditDetails(role) ? (
        <Text style={social.muted}>Edit the name, photo and permissions on the web app.</Text>
      ) : null}

      <Text style={social.label}>LEAVE OR CLOSE</Text>
      <Button
        title={`Leave ${noun}`}
        variant="secondary"
        onPress={() => {
          if (role === 'OWNER' && group.memberCount > 1) {
            Alert.alert(
              'Transfer ownership first',
              'Make another member the owner before leaving.',
            );
            return;
          }
          confirm(
            `Leave ${group.name}?`,
            'Its messages are erased from this device and your devices leave its encryption.',
            'Leave',
            () => {
              leaveOrDelete(api.groups.leave(conversationId));
            },
          );
        }}
      />
      {role === 'OWNER' ? (
        <>
          <Button
            title={group.archived ? 'Restore' : 'Archive'}
            variant="secondary"
            onPress={() => {
              run(api.groups.setArchived(conversationId, !group.archived));
            }}
          />
          <Button
            title={`Delete ${noun}`}
            variant="ghost"
            onPress={() => {
              confirm(
                `Delete ${group.name} for everyone?`,
                'All messages, files and encryption state are removed from OGC and members’ devices. This can’t be undone.',
                'Delete',
                () => {
                  leaveOrDelete(api.groups.delete(conversationId));
                },
              );
            }}
          />
        </>
      ) : null}
    </Screen>
  );
}

const CATEGORIES: { value: ReportCategory; label: string }[] = [
  { value: 'SPAM', label: 'Spam' },
  { value: 'HARASSMENT', label: 'Harassment' },
  { value: 'SCAM_OR_FRAUD', label: 'Scam or fraud' },
  { value: 'INAPPROPRIATE_CONTENT', label: 'Inappropriate content' },
  { value: 'OTHER', label: 'Something else' },
];

/** Reports a message; its decrypted text is shared only if the reporter turns it on. */
export function ReportMessageScreen({
  conversationId,
  messageId,
}: {
  conversationId: string;
  messageId: string;
}) {
  const nav = useNavigation();
  const api = useCommunity();
  const { engine } = useMessaging();
  const [category, setCategory] = useState<ReportCategory>('HARASSMENT');
  const [disclose, setDisclose] = useState(false);
  const [text, setText] = useState<string>();
  const [sender, setSender] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!engine) return;
    let active = true;
    void engine.messages(conversationId).then((list) => {
      const message = list.find((m) => m.id === messageId);
      if (!active || !message) return;
      setText(message.payload?.text);
      setSender(message.senderOgcId);
    });
    return () => {
      active = false;
    };
  }, [engine, conversationId, messageId]);

  return (
    <Screen
      title="Report message"
      subtitle="Messages are end-to-end encrypted: OGC sees the text only if you include it."
      onBack={nav.back}
    >
      {done ? (
        <Notice tone="success">Thanks — your report was sent to OGC’s safety team.</Notice>
      ) : (
        <>
          {CATEGORIES.map((c) => (
            <Pressable
              key={c.value}
              accessibilityRole="radio"
              accessibilityState={{ selected: category === c.value }}
              style={[social.option, category === c.value && social.optionSelected]}
              onPress={() => {
                setCategory(c.value);
              }}
            >
              <Text style={social.name}>{c.label}</Text>
            </Pressable>
          ))}
          {text ? (
            <View style={social.row}>
              <Switch
                value={disclose}
                onValueChange={setDisclose}
                accessibilityLabel="Include the message text"
              />
              <Text style={[social.body, { flex: 1 }]}>
                Include the message text (OGC’s safety team will read it)
              </Text>
            </View>
          ) : null}
          {disclose && text ? <Text style={social.card}>{text}</Text> : null}
          {error ? <Notice>{error}</Notice> : null}
          <Button
            title="Send report"
            onPress={() => {
              api.groups
                .report(conversationId, {
                  category,
                  messageId,
                  ...(sender ? { reportedOgcId: sender } : {}),
                  ...(disclose && text ? { disclosedText: text } : {}),
                })
                .then(
                  () => {
                    setDone(true);
                  },
                  (cause: unknown) => {
                    setError(errorMessage(cause));
                  },
                );
            }}
          />
        </>
      )}
    </Screen>
  );
}

/** Group and encrypted-channel invitations waiting for the user. */
export function InvitationsScreen() {
  const nav = useNavigation();
  const api = useCommunity();
  const { engine, invitationsRevision } = useMessaging();
  const [items, setItems] = useState<ReceivedInvitationView[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    api.groups.receivedInvitations().then(
      (list) => {
        if (active) setItems(list);
      },
      (cause: unknown) => {
        if (active) setError(errorMessage(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [api, invitationsRevision]);

  return (
    <Screen title="Invitations" onBack={nav.back}>
      {error ? <Notice>{error}</Notice> : null}
      {!items && !error ? <ActivityIndicator accessibilityLabel="Loading invitations" /> : null}
      {items?.length === 0 ? <Text style={social.empty}>No invitations right now.</Text> : null}
      {items?.map((invitation) => (
        <View key={invitation.id} style={social.card}>
          <View style={social.row}>
            <Avatar url={invitation.avatarUrl} name={invitation.name} size={44} />
            <View style={social.names}>
              <Text style={social.name}>{invitation.name}</Text>
              <Text style={social.muted}>
                {invitation.kind === 'CHANNEL' ? 'Encrypted channel' : 'Group'} ·{' '}
                {invitation.memberCount} members · from{' '}
                {invitation.inviter?.displayName ?? 'a former member'}
              </Text>
            </View>
          </View>
          <Button
            title="Join"
            onPress={() => {
              api.groups.acceptInvitation(invitation.id).then(
                async ({ conversationId }) => {
                  await engine?.refreshConversations().catch(() => undefined);
                  nav.replace({ name: 'conversation', conversationId });
                },
                (cause: unknown) => {
                  setError(errorMessage(cause));
                },
              );
            }}
          />
          <Button
            title="Decline"
            variant="ghost"
            onPress={() => {
              api.groups.declineInvitation(invitation.id).then(
                () => {
                  setItems((current) => current?.filter((i) => i.id !== invitation.id));
                },
                (cause: unknown) => {
                  setError(errorMessage(cause));
                },
              );
            }}
          />
        </View>
      ))}
    </Screen>
  );
}

/** Join with an invitation link (opened from a link/QR, or pasted). Joining needs a tap. */
export function JoinScreen({ token: initial }: { token?: string | undefined }) {
  const nav = useNavigation();
  const api = useCommunity();
  const { engine } = useMessaging();
  const [input, setInput] = useState(initial ?? '');
  const token = parseInviteToken(input);
  const [preview, setPreview] = useState<InvitePreview>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!token) return;
    let active = true;
    api.links.preview(token).then(
      (result) => {
        if (active) setPreview(result);
      },
      () => {
        if (active) setError('This invitation link is invalid or has expired.');
      },
    );
    return () => {
      active = false;
    };
  }, [api, token]);

  return (
    <Screen title="Join with a link" onBack={nav.back}>
      {!initial ? (
        <Field
          label="Invitation link"
          value={input}
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={(value) => {
            setInput(value);
            setError(undefined);
            setPreview(undefined);
          }}
        />
      ) : null}
      {error ? <Notice>{error}</Notice> : null}
      {preview ? (
        <View style={social.card}>
          <View style={social.row}>
            <Avatar url={preview.avatarUrl} name={preview.name} size={48} />
            <View style={social.names}>
              <Text style={social.name}>{preview.name}</Text>
              <Text style={social.muted}>{preview.memberCount} members</Text>
            </View>
          </View>
          <Text style={social.muted}>
            {preview.endToEndEncrypted
              ? 'End-to-end encrypted. You’ll see messages sent after you join.'
              : 'Community channel — not end-to-end encrypted; OGC can read posts for moderation and search.'}
          </Text>
          {pending ? (
            <Notice tone="success">Request sent — a moderator will review it.</Notice>
          ) : null}
          <Button
            title={
              preview.alreadyMember ? 'Open' : preview.requiresApproval ? 'Request to join' : 'Join'
            }
            busy={busy}
            onPress={() => {
              if (preview.alreadyMember) {
                nav.replace(
                  preview.target === 'COMMUNITY_CHANNEL'
                    ? { name: 'channel', channelId: preview.id }
                    : { name: 'conversation', conversationId: preview.id },
                );
                return;
              }
              if (!token) return;
              setBusy(true);
              api.links.join(token).then(
                async (result) => {
                  setBusy(false);
                  if (result.status === 'PENDING') {
                    setPending(true);
                    return;
                  }
                  if (result.target === 'COMMUNITY_CHANNEL') {
                    nav.replace({ name: 'channel', channelId: result.id });
                  } else {
                    await engine?.refreshConversations().catch(() => undefined);
                    nav.replace({ name: 'conversation', conversationId: result.id });
                  }
                },
                (cause: unknown) => {
                  setBusy(false);
                  setError(errorMessage(cause));
                },
              );
            }}
          />
        </View>
      ) : null}
    </Screen>
  );
}
