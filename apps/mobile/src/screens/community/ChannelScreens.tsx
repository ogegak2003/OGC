import type {
  ChannelMemberView,
  ChannelPostReportView,
  ChannelPostView,
  ChannelView,
  CreatedInviteLink,
  ModerationActionView,
  NotificationView,
} from '@ogc/types';
import { REACTION_EMOJI, REACTION_TYPES } from '@ogc/types';
import { color } from '@ogc/ui';
import {
  CHANNEL_POST_MAX_LENGTH,
  COMMUNITY_NAME_MAX_LENGTH,
  buildInviteUrl,
  canActOnMember,
  canManageInviteLinks,
  channelHandleSchema,
} from '@ogc/validation';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  Share,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { communityApi } from '../../api/community';
import { useAuth } from '../../auth/AuthProvider';
import { Avatar, LinkQrCode } from '../../components/identity';
import { Button, Field, Notice } from '../../components/ui';
import { errorMessage } from '../../lib/errors';
import { useMessaging } from '../../messaging/messaging-context';
import { useNavigation } from '../../navigation';
import { Screen } from '../Screen';
import { social } from '../social/styles';

const configuredWeb: unknown = process.env.EXPO_PUBLIC_WEB_APP_URL;
const LINK_ORIGIN = typeof configuredWeb === 'string' ? configuredWeb : 'http://localhost:5173';
const NOT_E2EE =
  'Community channels are not end-to-end encrypted: OGC can read posts for moderation and search.';

function useCommunity() {
  const { client } = useAuth();
  return useMemo(() => communityApi(client), [client]);
}

function ChannelRow({ channel }: { channel: ChannelView }) {
  const nav = useNavigation();
  return (
    <Pressable
      style={social.listItem}
      accessibilityRole="button"
      accessibilityLabel={`${channel.name}${channel.unreadCount ? `, ${String(channel.unreadCount)} unread` : ''}`}
      onPress={() => {
        nav.push({ name: 'channel', channelId: channel.id });
      }}
    >
      <Avatar url={channel.avatarUrl} name={channel.name} size={40} />
      <View style={social.names}>
        <Text style={social.name}>{channel.name}</Text>
        <Text style={social.ogcId}>
          @{channel.handle} · {channel.memberCount} members
          {channel.visibility === 'PRIVATE' ? ' · Private' : ''}
          {channel.membership?.status === 'PENDING' ? ' · Pending' : ''}
        </Text>
      </View>
      {channel.unreadCount > 0 ? <Text style={social.badge}>{channel.unreadCount}</Text> : null}
    </Pressable>
  );
}

/** The user's channels and the public directory with search. */
export function ChannelsScreen() {
  const nav = useNavigation();
  const api = useCommunity();
  const [tab, setTab] = useState<'mine' | 'discover'>('mine');
  const [mine, setMine] = useState<ChannelView[]>();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<ChannelView[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    api.channels.mine().then(
      (list) => {
        if (active) setMine(list);
      },
      (cause: unknown) => {
        if (active) setError(errorMessage(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    if (tab !== 'discover') return;
    let active = true;
    const timer = setTimeout(() => {
      api.channels.discover(query).then(
        (page) => {
          if (active) setFound(page.items);
        },
        (cause: unknown) => {
          if (active) setError(errorMessage(cause));
        },
      );
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, tab, query]);

  return (
    <Screen title="Channels" subtitle="Open spaces for larger audiences." onBack={nav.back}>
      <Text style={social.muted}>{NOT_E2EE} Use groups for private conversations.</Text>
      <View style={social.tabs}>
        {(['mine', 'discover'] as const).map((value) => (
          <Pressable
            key={value}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === value }}
            style={[social.tab, tab === value && social.tabActive]}
            onPress={() => {
              setTab(value);
            }}
          >
            <Text style={[social.tabText, tab === value && social.tabTextActive]}>
              {value === 'mine' ? 'My channels' : 'Discover'}
            </Text>
          </Pressable>
        ))}
      </View>
      {error ? <Notice>{error}</Notice> : null}
      {tab === 'mine' ? (
        <>
          {!mine && !error ? <ActivityIndicator accessibilityLabel="Loading channels" /> : null}
          {mine?.length === 0 ? (
            <Text style={social.empty}>No channels yet — find some in Discover.</Text>
          ) : null}
          {mine?.map((channel) => (
            <ChannelRow key={channel.id} channel={channel} />
          ))}
        </>
      ) : (
        <>
          <TextInput
            style={social.input}
            placeholder="Search public channels"
            placeholderTextColor={color.textDisabled}
            accessibilityLabel="Search public channels"
            value={query}
            maxLength={64}
            onChangeText={setQuery}
            autoCorrect={false}
          />
          {found?.length === 0 ? <Text style={social.empty}>No channels found.</Text> : null}
          {found?.map((channel) => (
            <ChannelRow key={channel.id} channel={channel} />
          ))}
        </>
      )}
      <Button
        title="New channel"
        variant="secondary"
        onPress={() => {
          nav.push({ name: 'new-channel' });
        }}
      />
    </Screen>
  );
}

export function CreateChannelScreen() {
  const nav = useNavigation();
  const api = useCommunity();
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const [approval, setApproval] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <Screen title="New channel" onBack={nav.back}>
      <Notice tone="success">{NOT_E2EE}</Notice>
      <Field
        label="Name"
        value={name}
        maxLength={COMMUNITY_NAME_MAX_LENGTH}
        onChangeText={setName}
      />
      <Field
        label="Handle"
        value={handle}
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setHandle}
      />
      <View style={social.row}>
        <Switch value={isPrivate} onValueChange={setPrivate} accessibilityLabel="Private channel" />
        <Text style={[social.body, { flex: 1 }]}>
          Private — members only, join by invitation link
        </Text>
      </View>
      <View style={social.row}>
        <Switch
          value={approval}
          onValueChange={setApproval}
          accessibilityLabel="Approve new members"
        />
        <Text style={[social.body, { flex: 1 }]}>Moderators approve new members</Text>
      </View>
      {error ? <Notice>{error}</Notice> : null}
      <Button
        title="Create channel"
        busy={busy}
        onPress={() => {
          const parsed = channelHandleSchema.safeParse(handle);
          if (!parsed.success || !name.trim()) {
            setError('Enter a name and a handle of 5–32 letters, digits or underscores.');
            return;
          }
          setBusy(true);
          api.channels
            .create({
              handle: parsed.data,
              name: name.trim(),
              visibility: isPrivate ? 'PRIVATE' : 'PUBLIC',
              joinPolicy: approval ? 'APPROVAL' : 'OPEN',
            })
            .then(
              (channel) => {
                nav.replace({ name: 'channel', channelId: channel.id });
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

function PostItem({
  post,
  channel,
  onChanged,
  onError,
}: {
  post: ChannelPostView;
  channel: ChannelView;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const nav = useNavigation();
  const api = useCommunity();
  const { engine } = useMessaging();
  const mine = post.author?.ogcId === engine?.ogcId;
  const member = channel.membership?.status === 'ACTIVE';
  const hidden = post.deletedAt !== null || post.removed;
  const run = (task: Promise<unknown>) => {
    task.then(onChanged, (cause: unknown) => {
      onError(errorMessage(cause));
    });
  };
  const actions = () => {
    const list: { text: string; style?: 'destructive'; onPress: () => void }[] = [];
    if (member && !hidden && !channel.archived) {
      for (const reaction of REACTION_TYPES) {
        const own = post.reactions.some((r) => r.reaction === reaction && r.mine);
        list.push({
          text: `${REACTION_EMOJI[reaction]}${own ? ' (remove)' : ''}`,
          onPress: () => {
            run(api.channels.react(post.id, reaction, !own));
          },
        });
      }
    }
    if (mine && !post.deletedAt) {
      list.push({
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          run(api.channels.deletePost(post.id));
        },
      });
    }
    if (channel.canModerate && !post.deletedAt) {
      if (!post.replyToId && !post.removed) {
        list.push({
          text: post.pinnedAt ? 'Unpin' : 'Pin',
          onPress: () => {
            run(api.channels.pin(post.id, post.pinnedAt === null));
          },
        });
      }
      if (!mine) {
        list.push({
          text: post.removed ? 'Restore' : 'Remove',
          ...(post.removed ? {} : { style: 'destructive' as const }),
          onPress: () => {
            run(api.channels.moderatePost(post.id, !post.removed));
          },
        });
      }
    }
    if (!mine && !hidden) {
      list.push({
        text: 'Report',
        onPress: () => {
          run(api.channels.reportPost(post.id, 'SPAM'));
          Alert.alert('Reported', 'The channel’s moderators will review it.');
        },
      });
    }
    return list;
  };
  return (
    <Pressable
      style={[social.card, post.announcement ? { borderColor: color.accent } : null]}
      accessibilityRole="button"
      accessibilityHint="Long press for actions"
      onLongPress={() => {
        const list = actions();
        if (list.length)
          Alert.alert('Post', undefined, [...list, { text: 'Close', style: 'cancel' }]);
      }}
      onPress={() => {
        if (!post.replyToId)
          nav.push({ name: 'channel-thread', channelId: channel.id, postId: post.id });
      }}
    >
      <View style={social.row}>
        <Avatar
          url={post.author?.avatarUrl ?? null}
          name={post.author?.displayName ?? '?'}
          size={28}
        />
        <Text style={[social.name, { flex: 1 }]}>
          {post.author?.displayName ?? 'Former member'}
        </Text>
        {post.announcement ? <Text style={social.badge}>Announcement</Text> : null}
        {post.pinnedAt ? <Text style={social.badge}>Pinned</Text> : null}
      </View>
      {post.deletedAt ? <Text style={social.muted}>This post was deleted</Text> : null}
      {post.removed && !post.deletedAt ? (
        <Text style={social.muted}>Removed by a moderator</Text>
      ) : null}
      {post.removedBody ? <Text style={social.muted}>{post.removedBody}</Text> : null}
      {!hidden && post.body ? <Text style={social.body}>{post.body}</Text> : null}
      {!hidden && post.attachments.length ? (
        <Text style={social.muted}>{post.attachments.map((a) => a.name).join(', ')}</Text>
      ) : null}
      <Text style={social.muted}>
        {post.reactions.map((r) => `${REACTION_EMOJI[r.reaction]} ${String(r.count)}`).join('  ')}
        {!post.replyToId ? `  ${String(post.replyCount)} replies` : ''}
      </Text>
    </Pressable>
  );
}

function Composer({
  channel,
  replyToId,
  onPosted,
}: {
  channel: ChannelView;
  replyToId?: string;
  onPosted: () => void;
}) {
  const api = useCommunity();
  const [body, setBody] = useState('');
  const [announcement, setAnnouncement] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const admin = channel.membership?.role === 'OWNER' || channel.membership?.role === 'ADMIN';
  return (
    <View style={{ gap: 8 }}>
      <TextInput
        style={social.input}
        multiline
        maxLength={CHANNEL_POST_MAX_LENGTH}
        placeholder={replyToId ? 'Write a reply…' : 'Write a post…'}
        placeholderTextColor={color.textDisabled}
        accessibilityLabel={replyToId ? 'Reply' : 'Write a post'}
        value={body}
        onChangeText={setBody}
      />
      {admin && !replyToId ? (
        <View style={social.row}>
          <Switch
            value={announcement}
            onValueChange={setAnnouncement}
            accessibilityLabel="Announcement"
          />
          <Text style={social.body}>Announcement (notifies members)</Text>
        </View>
      ) : null}
      {error ? <Notice>{error}</Notice> : null}
      <Button
        title={replyToId ? 'Reply' : 'Post'}
        busy={busy}
        onPress={() => {
          if (!body.trim()) return;
          setBusy(true);
          setError(undefined);
          api.channels
            .post(channel.id, {
              clientPostId: crypto.randomUUID(),
              body: body.trim(),
              ...(replyToId ? { replyToId } : {}),
              ...(announcement && !replyToId ? { announcement: true } : {}),
            })
            .then(
              () => {
                setBusy(false);
                setBody('');
                setAnnouncement(false);
                onPosted();
              },
              (cause: unknown) => {
                setBusy(false);
                setError(errorMessage(cause));
              },
            );
        }}
      />
    </View>
  );
}

/** A community channel: feed, pinned posts, join/leave and a composer when allowed. */
export function ChannelScreen({ channelId }: { channelId: string }) {
  const nav = useNavigation();
  const api = useCommunity();
  const { channelRevision } = useMessaging();
  const revision = channelRevision[channelId] ?? 0;
  const [channel, setChannel] = useState<ChannelView>();
  const [posts, setPosts] = useState<ChannelPostView[]>([]);
  const [pinned, setPinned] = useState<ChannelPostView[]>([]);
  const [error, setError] = useState<string>();
  const [missing, setMissing] = useState(false);
  const [reload, setReload] = useState(0);
  const refresh = () => {
    setReload((n) => n + 1);
  };

  useEffect(() => {
    let active = true;
    Promise.all([
      api.channels.get(channelId),
      api.channels.posts(channelId),
      api.channels.pinned(channelId),
    ]).then(
      ([view, feed, pins]) => {
        if (!active) return;
        setChannel(view);
        setPosts(feed.items);
        setPinned(pins);
        if (view.membership?.status === 'ACTIVE' && view.unreadCount > 0) {
          void api.channels.markRead(channelId, view.version).catch(() => undefined);
        }
      },
      (cause: unknown) => {
        if (!active) return;
        if ((cause as { status?: number }).status === 404) setMissing(true);
        else setError(errorMessage(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [api, channelId, revision, reload]);

  if (missing) {
    return (
      <Screen title="Channel" onBack={nav.back}>
        <Notice>This channel doesn’t exist or isn’t available to you.</Notice>
      </Screen>
    );
  }
  if (!channel) {
    return (
      <Screen title="Channel" onBack={nav.back}>
        {error ? (
          <Notice>{error}</Notice>
        ) : (
          <ActivityIndicator accessibilityLabel="Loading channel" />
        )}
      </Screen>
    );
  }
  const member = channel.membership?.status === 'ACTIVE';
  const run = (task: Promise<unknown>) => {
    task.then(refresh, (cause: unknown) => {
      setError(errorMessage(cause));
    });
  };
  return (
    <Screen
      title={channel.name}
      subtitle={`@${channel.handle} · ${String(channel.memberCount)} members · Not end-to-end encrypted`}
      onBack={nav.back}
    >
      {channel.description ? <Text style={social.body}>{channel.description}</Text> : null}
      {error ? <Notice>{error}</Notice> : null}
      {channel.archived ? (
        <Notice tone="success">This channel is archived and read-only.</Notice>
      ) : null}
      {!channel.membership ? (
        <Button
          title={channel.joinPolicy === 'APPROVAL' ? 'Request to join' : 'Join'}
          onPress={() => {
            run(api.channels.join(channel.id));
          }}
        />
      ) : null}
      {channel.membership?.status === 'PENDING' ? (
        <Text style={social.muted}>Your request is waiting for a moderator.</Text>
      ) : null}
      {member ? (
        <Button
          title={channel.canModerate ? 'Manage channel' : 'Channel settings'}
          variant="secondary"
          onPress={() => {
            nav.push({ name: 'channel-manage', channelId: channel.id });
          }}
        />
      ) : null}
      {pinned.length ? <Text style={social.label}>PINNED</Text> : null}
      {pinned.map((post) => (
        <PostItem
          key={`pin-${post.id}`}
          post={post}
          channel={channel}
          onChanged={refresh}
          onError={setError}
        />
      ))}
      {channel.canPost ? <Composer channel={channel} onPosted={refresh} /> : null}
      {member && !channel.canPost && !channel.archived ? (
        <Text style={social.muted}>
          Admins write posts here; you can reply and react (long press a post).
        </Text>
      ) : null}
      {posts.length === 0 ? <Text style={social.empty}>No posts yet.</Text> : null}
      {posts.map((post) => (
        <PostItem
          key={post.id}
          post={post}
          channel={channel}
          onChanged={refresh}
          onError={setError}
        />
      ))}
    </Screen>
  );
}

/** A post and its replies (discussion). */
export function ChannelThreadScreen({ channelId, postId }: { channelId: string; postId: string }) {
  const nav = useNavigation();
  const api = useCommunity();
  const { channelRevision } = useMessaging();
  const revision = channelRevision[channelId] ?? 0;
  const [channel, setChannel] = useState<ChannelView>();
  const [thread, setThread] = useState<{ post: ChannelPostView; replies: ChannelPostView[] }>();
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    Promise.all([api.channels.get(channelId), api.channels.thread(postId)]).then(
      ([view, result]) => {
        if (!active) return;
        setChannel(view);
        setThread({ post: result.post, replies: result.replies.items });
      },
      (cause: unknown) => {
        if (active) setError(errorMessage(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [api, channelId, postId, revision, reload]);
  const refresh = () => {
    setReload((n) => n + 1);
  };
  return (
    <Screen title="Discussion" onBack={nav.back}>
      {error ? <Notice>{error}</Notice> : null}
      {channel && thread ? (
        <>
          <PostItem post={thread.post} channel={channel} onChanged={refresh} onError={setError} />
          {thread.replies.map((reply) => (
            <PostItem
              key={reply.id}
              post={reply}
              channel={channel}
              onChanged={refresh}
              onError={setError}
            />
          ))}
          {channel.canReply ? (
            <Composer channel={channel} replyToId={thread.post.id} onPosted={refresh} />
          ) : null}
        </>
      ) : (
        <ActivityIndicator accessibilityLabel="Loading discussion" />
      )}
    </Screen>
  );
}

/** Settings for members; members, requests, reports, history and links for moderators and admins. */
export function ChannelManageScreen({ channelId }: { channelId: string }) {
  const nav = useNavigation();
  const api = useCommunity();
  const { engine } = useMessaging();
  const [channel, setChannel] = useState<ChannelView>();
  const [members, setMembers] = useState<ChannelMemberView[]>([]);
  const [requests, setRequests] = useState<ChannelMemberView[]>([]);
  const [reports, setReports] = useState<ChannelPostReportView[]>([]);
  const [history, setHistory] = useState<ModerationActionView[]>([]);
  const [link, setLink] = useState<CreatedInviteLink>();
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const view = await api.channels.get(channelId);
      const memberList = await api.channels.members(channelId);
      const extra = view.canModerate
        ? await Promise.all([
            api.channels.members(channelId, 'PENDING'),
            api.channels.reports(channelId),
            api.channels.history(channelId),
          ])
        : undefined;
      if (!active) return;
      setChannel(view);
      setMembers(memberList.items);
      if (extra) {
        setRequests(extra[0].items);
        setReports(extra[1].items);
        setHistory(extra[2].items);
      }
    };
    load().catch((cause: unknown) => {
      if (active) setError(errorMessage(cause));
    });
    return () => {
      active = false;
    };
  }, [api, channelId, reload]);

  if (!channel) {
    return (
      <Screen title="Channel" onBack={nav.back}>
        {error ? <Notice>{error}</Notice> : <ActivityIndicator accessibilityLabel="Loading" />}
      </Screen>
    );
  }
  const role = channel.membership?.role ?? 'MEMBER';
  const run = (task: Promise<unknown>) => {
    setError(undefined);
    task.then(
      () => {
        setReload((n) => n + 1);
      },
      (cause: unknown) => {
        setError(errorMessage(cause));
      },
    );
  };
  return (
    <Screen
      title={channel.name}
      subtitle={channel.canModerate ? 'Manage' : 'Settings'}
      onBack={nav.back}
    >
      {error ? <Notice>{error}</Notice> : null}
      <Text style={social.label}>NOTIFICATIONS</Text>
      <View style={social.tabs}>
        {(['ALL', 'MENTIONS', 'NONE'] as const).map((level) => (
          <Pressable
            key={level}
            accessibilityRole="tab"
            accessibilityState={{ selected: channel.membership?.notificationLevel === level }}
            style={[
              social.tab,
              channel.membership?.notificationLevel === level && social.tabActive,
            ]}
            onPress={() => {
              run(api.channels.setPreferences(channel.id, { level }));
            }}
          >
            <Text
              style={[
                social.tabText,
                channel.membership?.notificationLevel === level && social.tabTextActive,
              ]}
            >
              {level === 'ALL' ? 'All' : level === 'MENTIONS' ? 'Mentions' : 'Off'}
            </Text>
          </Pressable>
        ))}
      </View>

      {canManageInviteLinks(role) && !channel.archived ? (
        <>
          <Text style={social.label}>INVITATION LINK</Text>
          {link ? (
            <>
              <LinkQrCode
                payload={buildInviteUrl(LINK_ORIGIN, link.token)}
                label={`Invitation QR code for ${channel.name}`}
              />
              <Button
                title="Share link"
                onPress={() => {
                  void Share.share({
                    title: `Join ${channel.name} on OGC`,
                    message: buildInviteUrl(LINK_ORIGIN, link.token),
                  });
                }}
              />
            </>
          ) : (
            <Button
              title="Create invitation link"
              variant="secondary"
              onPress={() => {
                api.links
                  .create({ channelId: channel.id }, { expiresInHours: 7 * 24 })
                  .then(setLink, (cause: unknown) => {
                    setError(errorMessage(cause));
                  });
              }}
            />
          )}
        </>
      ) : null}

      <Text style={social.label}>
        {channel.canModerate ? 'MEMBERS' : 'PEOPLE WHO RUN THIS CHANNEL'}
      </Text>
      {members.map((m) => {
        const self = m.profile.ogcId === engine?.ogcId;
        const act = !self && canActOnMember(role, m.role, 'COMMUNITY_CHANNEL');
        return (
          <Pressable
            key={m.profile.ogcId}
            style={social.listItem}
            accessibilityRole="button"
            accessibilityLabel={`${m.profile.displayName}, ${m.role.toLowerCase()}`}
            disabled={!act}
            onPress={() => {
              Alert.alert(m.profile.displayName, undefined, [
                {
                  text: 'Suspend 24 hours',
                  onPress: () => {
                    run(api.channels.suspend(channel.id, m.profile.ogcId, 24));
                  },
                },
                {
                  text: 'Remove',
                  onPress: () => {
                    run(api.channels.removeMember(channel.id, m.profile.ogcId));
                  },
                },
                {
                  text: 'Ban',
                  style: 'destructive',
                  onPress: () => {
                    run(api.channels.ban(channel.id, m.profile.ogcId));
                  },
                },
                { text: 'Close', style: 'cancel' },
              ]);
            }}
          >
            <Avatar url={m.profile.avatarUrl} name={m.profile.displayName} size={32} />
            <Text style={[social.name, { flex: 1 }]}>{m.profile.displayName}</Text>
            <Text style={social.badge}>{m.role.toLowerCase()}</Text>
          </Pressable>
        );
      })}

      {channel.canModerate ? (
        <>
          <Text style={social.label}>JOIN REQUESTS</Text>
          {requests.length === 0 ? <Text style={social.muted}>No pending requests.</Text> : null}
          {requests.map((r) => (
            <View key={r.profile.ogcId} style={social.listItem}>
              <Text style={[social.name, { flex: 1 }]}>{r.profile.displayName}</Text>
              <Text
                style={{ color: color.accent }}
                accessibilityRole="button"
                onPress={() => {
                  run(api.channels.decideRequest(channel.id, r.profile.ogcId, true));
                }}
              >
                Approve
              </Text>
              <Text
                style={{ color: color.textSecondary }}
                accessibilityRole="button"
                onPress={() => {
                  run(api.channels.decideRequest(channel.id, r.profile.ogcId, false));
                }}
              >
                Reject
              </Text>
            </View>
          ))}
          <Text style={social.label}>REPORTS</Text>
          {reports.length === 0 ? <Text style={social.muted}>No open reports.</Text> : null}
          {reports.map((r) => (
            <View key={r.id} style={social.card}>
              <Text style={social.muted}>{r.category.replaceAll('_', ' ').toLowerCase()}</Text>
              <Text style={social.body}>{r.post.body ?? r.post.removedBody ?? '(no text)'}</Text>
              <Button
                title="Remove post"
                variant="secondary"
                onPress={() => {
                  run(api.channels.resolveReport(r.id, 'RESOLVED', true));
                }}
              />
              <Button
                title="Dismiss"
                variant="ghost"
                onPress={() => {
                  run(api.channels.resolveReport(r.id, 'DISMISSED', false));
                }}
              />
            </View>
          ))}
          <Text style={social.label}>MODERATION HISTORY</Text>
          {history.map((h) => (
            <Text key={h.id} style={social.muted}>
              {h.moderator?.displayName ?? 'A moderator'} ·{' '}
              {h.action.replaceAll('_', ' ').toLowerCase()}
              {h.target ? ` · ${h.target.displayName}` : ''}
              {h.reason ? ` — “${h.reason}”` : ''}
            </Text>
          ))}
        </>
      ) : null}

      {role === 'OWNER' ? (
        <Button
          title={channel.visibility === 'PUBLIC' ? 'Make private' : 'Make public'}
          variant="secondary"
          onPress={() => {
            Alert.alert(
              channel.visibility === 'PUBLIC'
                ? 'Make the channel private?'
                : 'Make the channel public?',
              `${
                channel.visibility === 'PUBLIC'
                  ? 'It disappears from discovery; only members can read it.'
                  : 'Anyone on OGC can find it and read all posts, including older ones.'
              } Posts stay readable by OGC either way.`,
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Change',
                  style: 'destructive',
                  onPress: () => {
                    run(
                      api.channels.changeVisibility(
                        channel.id,
                        channel.visibility === 'PUBLIC' ? 'PRIVATE' : 'PUBLIC',
                      ),
                    );
                  },
                },
              ],
            );
          }}
        />
      ) : (
        <Button
          title="Leave channel"
          variant="ghost"
          onPress={() => {
            api.channels.leave(channel.id).then(
              () => {
                nav.replace({ name: 'channels' });
              },
              (cause: unknown) => {
                setError(errorMessage(cause));
              },
            );
          }}
        />
      )}
    </Screen>
  );
}

function describe(n: NotificationView): string {
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const group = text(n.data.groupName) || 'a group';
  const channel = text(n.data.channelName) || 'a channel';
  switch (n.type) {
    case 'GROUP_INVITATION':
      return `You’re invited to ${group}`;
    case 'GROUP_MEMBER_ADDED':
      return 'Someone accepted your invitation';
    case 'GROUP_MEMBER_REMOVED':
      return `You were removed from ${group}`;
    case 'GROUP_ROLE_CHANGED':
      return `Your role in ${group} changed`;
    case 'GROUP_DETAILS_CHANGED':
      return `${group} was updated`;
    case 'MENTION':
      return `You were mentioned in ${text(n.data.groupName) || channel}`;
    case 'CHANNEL_ANNOUNCEMENT':
      return `New announcement in ${channel}`;
    case 'CHANNEL_ROLE_CHANGED':
      return `Your role in ${channel} changed`;
    case 'CHANNEL_JOIN_REQUEST':
      return `Someone asked to join ${channel}`;
    case 'CHANNEL_REQUEST_APPROVED':
      return `You can now take part in ${channel}`;
    case 'CHANNEL_MEMBER_REMOVED':
      return `A moderator changed your access to ${channel}`;
    case 'MODERATION_RESULT':
      return `Moderators reviewed your report in ${channel}`;
    case 'INVITATION_EXPIRED':
      return `An invitation you sent to ${group} expired`;
  }
}

/** In-app notifications, newest first. Opening the screen marks them read. */
export function NotificationsScreen() {
  const nav = useNavigation();
  const api = useCommunity();
  const { setNotificationsUnread } = useMessaging();
  const [items, setItems] = useState<NotificationView[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    api.notifications.list().then(
      (page) => {
        if (!active) return;
        setItems(page.items);
        if (page.unread > 0) {
          void api.notifications.markAllRead().then(() => {
            setNotificationsUnread(0);
          });
        }
      },
      (cause: unknown) => {
        if (active) setError(errorMessage(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [api, setNotificationsUnread]);
  return (
    <Screen title="Notifications" onBack={nav.back}>
      {error ? <Notice>{error}</Notice> : null}
      {!items && !error ? <ActivityIndicator accessibilityLabel="Loading notifications" /> : null}
      {items?.length === 0 ? <Text style={social.empty}>You’re all caught up.</Text> : null}
      {items?.map((n) => (
        <Pressable
          key={n.id}
          style={social.listItem}
          accessibilityRole="button"
          onPress={() => {
            const channelId = typeof n.data.channelId === 'string' ? n.data.channelId : undefined;
            const conversationId =
              typeof n.data.conversationId === 'string' ? n.data.conversationId : undefined;
            if (n.type === 'GROUP_INVITATION') nav.push({ name: 'invitations' });
            else if (channelId) nav.push({ name: 'channel', channelId });
            else if (conversationId) nav.push({ name: 'conversation', conversationId });
          }}
        >
          <View style={social.names}>
            <Text style={[social.name, n.readAt ? null : { color: color.accent }]}>
              {describe(n)}
            </Text>
            <Text style={social.ogcId}>{new Date(n.createdAt).toLocaleString()}</Text>
          </View>
        </Pressable>
      ))}
    </Screen>
  );
}
