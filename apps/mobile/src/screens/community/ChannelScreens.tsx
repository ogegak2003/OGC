import { isMissedCall } from '@ogc/messaging';
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
import { fontSize, fontWeight, radius, space } from '@ogc/ui';
import {
  CHANNEL_POST_MAX_LENGTH,
  COMMUNITY_NAME_MAX_LENGTH,
  buildInviteUrl,
  canActOnMember,
  canManageInviteLinks,
  channelHandleSchema,
} from '@ogc/validation';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { communityApi } from '../../api/community';
import { webAppUrl } from '../../config/runtime';
import { useAuth } from '../../auth/AuthProvider';
import { Icon, type IconName } from '../../components/Icon';
import { Avatar, KindAvatar, LinkQrCode } from '../../components/identity';
import {
  Button,
  CountBadge,
  EmptyState,
  Field,
  IconButton,
  ListGroup,
  ListRow,
  Loading,
  Notice,
  SectionHeader,
  SkeletonRows,
  SwitchRow,
  Tabs,
  Tag,
} from '../../components/ui';
import { listTime } from '../../lib/time';
import { errorMessage } from '../../lib/errors';
import { useRecentCalls } from '../../messaging/hooks';
import { useMessaging } from '../../messaging/messaging-context';
import { useNavigation } from '../../navigation';
import { Screen } from '../Screen';
import { social } from '../social/styles';
import { color, themedStyles } from '../../theme';

const NOT_E2EE =
  'Community channels are not end-to-end encrypted: OGC can read posts for moderation and search.';

function useCommunity() {
  const { client } = useAuth();
  return useMemo(() => communityApi(client), [client]);
}

export function ChannelRow({ channel }: { channel: ChannelView }) {
  const nav = useNavigation();
  return (
    <ListRow
      title={channel.name}
      subtitle={`Community · @${channel.handle} · ${String(channel.memberCount)} ${channel.memberCount === 1 ? 'member' : 'members'}${
        channel.visibility === 'PRIVATE' ? ' · Private' : ''
      }${channel.membership?.status === 'PENDING' ? ' · Pending' : ''}`}
      leading={
        <KindAvatar
          url={channel.avatarUrl}
          name={channel.name}
          size={44}
          kind="community-channel"
        />
      }
      trailing={<CountBadge count={channel.unreadCount} />}
      accessibilityLabel={`${channel.name}${channel.unreadCount ? `, ${String(channel.unreadCount)} unread` : ''}`}
      onPress={() => {
        nav.push({ name: 'channel', channelId: channel.id });
      }}
    />
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
      <Notice tone="info">{NOT_E2EE} Use groups for private conversations.</Notice>
      <Tabs
        options={[
          { id: 'mine', label: 'My channels' },
          { id: 'discover', label: 'Discover' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {error ? <Notice>{error}</Notice> : null}
      {tab === 'mine' ? (
        <>
          {!mine && !error ? (
            <View style={styles.surface}>
              <SkeletonRows count={3} label="Loading channels" />
            </View>
          ) : null}
          {mine?.length === 0 ? (
            <EmptyState
              icon="hash"
              title="No channels yet — find some in Discover."
              action={{
                label: 'Discover channels',
                icon: 'search',
                onPress: () => {
                  setTab('discover');
                },
              }}
            />
          ) : null}
          {mine?.length ? (
            <ListGroup>
              {mine.map((channel) => (
                <ChannelRow key={channel.id} channel={channel} />
              ))}
            </ListGroup>
          ) : null}
        </>
      ) : (
        <>
          <Field
            label="Search public channels"
            icon="search"
            placeholder="Name or @handle"
            value={query}
            maxLength={64}
            onChangeText={setQuery}
            autoCorrect={false}
            autoCapitalize="none"
          />
          {found?.length === 0 ? <EmptyState icon="search" title="No channels found." /> : null}
          {found?.length ? (
            <ListGroup>
              {found.map((channel) => (
                <ChannelRow key={channel.id} channel={channel} />
              ))}
            </ListGroup>
          ) : null}
        </>
      )}
      <Button
        title="New channel"
        variant="secondary"
        icon="plus"
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
      <Notice tone="info">{NOT_E2EE}</Notice>
      <Field
        label="Name"
        value={name}
        maxLength={COMMUNITY_NAME_MAX_LENGTH}
        onChangeText={setName}
      />
      <Field
        label="Handle"
        icon="at"
        value={handle}
        autoCapitalize="none"
        autoCorrect={false}
        hint="5–32 letters, digits or underscores. People find the channel by it."
        onChangeText={setHandle}
      />
      <ListGroup>
        <SwitchRow
          label="Private channel"
          description="Members only, join by invitation link"
          value={isPrivate}
          onValueChange={setPrivate}
        />
        <SwitchRow
          label="Approve new members"
          description="Moderators approve each request to join"
          value={approval}
          onValueChange={setApproval}
        />
      </ListGroup>
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
      style={({ pressed }) => [
        styles.post,
        post.announcement ? styles.announcement : null,
        pressed && styles.postPressed,
      ]}
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
          size={36}
        />
        <View style={social.names}>
          <Text style={styles.author} numberOfLines={1}>
            {post.author?.displayName ?? 'Former member'}
          </Text>
          <Text style={styles.when}>{listTime(post.createdAt)}</Text>
        </View>
      </View>
      {post.announcement || post.pinnedAt ? (
        <View style={styles.tags}>
          {post.announcement ? <Tag label="Announcement" tone="accent" icon="megaphone" /> : null}
          {post.pinnedAt ? <Tag label="Pinned" icon="pin" /> : null}
        </View>
      ) : null}
      {post.deletedAt ? <Text style={social.muted}>This post was deleted</Text> : null}
      {post.removed && !post.deletedAt ? (
        <Text style={social.muted}>Removed by a moderator</Text>
      ) : null}
      {post.removedBody ? <Text style={social.muted}>{post.removedBody}</Text> : null}
      {!hidden && post.body ? <Text style={social.body}>{post.body}</Text> : null}
      {!hidden && post.attachments.length ? (
        <Text style={social.muted}>{post.attachments.map((a) => a.name).join(', ')}</Text>
      ) : null}
      <View style={styles.postFooter}>
        {post.reactions.map((r) => (
          <Text key={r.reaction} style={[styles.reaction, r.mine ? styles.reactionMine : null]}>
            {REACTION_EMOJI[r.reaction]} {r.count}
          </Text>
        ))}
        {!post.replyToId ? (
          <View style={styles.replies}>
            <Icon name="chat" size={14} tint={color.textMuted} />
            <Text style={styles.repliesText}>{post.replyCount} replies</Text>
          </View>
        ) : null}
      </View>
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
    <View style={styles.composer}>
      <TextInput
        style={[social.input, styles.composerInput]}
        selectionColor={color.accent}
        multiline
        maxLength={CHANNEL_POST_MAX_LENGTH}
        placeholder={replyToId ? 'Write a reply…' : 'Write a post…'}
        placeholderTextColor={color.textDisabled}
        accessibilityLabel={replyToId ? 'Reply' : 'Write a post'}
        value={body}
        onChangeText={setBody}
      />
      {admin && !replyToId ? (
        <SwitchRow
          label="Announcement"
          description="Notifies members"
          value={announcement}
          onValueChange={setAnnouncement}
        />
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
        {error ? <Notice>{error}</Notice> : <Loading label="Loading channel" />}
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
      <View style={styles.channelHead}>
        <Avatar url={channel.avatarUrl} name={channel.name} size={56} />
        <View style={styles.channelTags}>
          {channel.visibility === 'PRIVATE' ? (
            <Tag label="Private" icon="lock" />
          ) : (
            <Tag label="Public" icon="compass" />
          )}
          {member ? <Tag label="Member" tone="success" icon="check" /> : null}
        </View>
      </View>
      {channel.description ? <Text style={social.body}>{channel.description}</Text> : null}
      {error ? <Notice>{error}</Notice> : null}
      {channel.archived ? (
        <Notice tone="info">This channel is archived and read-only.</Notice>
      ) : null}
      {!channel.membership ? (
        <Button
          icon="plus"
          title={channel.joinPolicy === 'APPROVAL' ? 'Request to join' : 'Join'}
          onPress={() => {
            run(api.channels.join(channel.id));
          }}
        />
      ) : null}
      {channel.membership?.status === 'PENDING' ? (
        <Notice tone="info">Your request is waiting for a moderator.</Notice>
      ) : null}
      {member ? (
        <Button
          title={channel.canModerate ? 'Manage channel' : 'Channel settings'}
          variant="secondary"
          icon="settings"
          onPress={() => {
            nav.push({ name: 'channel-manage', channelId: channel.id });
          }}
        />
      ) : null}
      {pinned.length ? <SectionHeader title="Pinned" /> : null}
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
      {pinned.length || posts.length ? <SectionHeader title="Posts" /> : null}
      {posts.length === 0 ? <EmptyState icon="megaphone" title="No posts yet." /> : null}
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
        <Loading label="Loading discussion" />
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
        {error ? <Notice>{error}</Notice> : <Loading label="Loading" />}
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
      <SectionHeader title="Notifications" />
      <Tabs
        options={[
          { id: 'ALL', label: 'All' },
          { id: 'MENTIONS', label: 'Mentions' },
          { id: 'NONE', label: 'Off' },
        ]}
        value={channel.membership?.notificationLevel ?? 'ALL'}
        onChange={(level) => {
          run(api.channels.setPreferences(channel.id, { level }));
        }}
      />

      {canManageInviteLinks(role) && !channel.archived ? (
        <>
          <SectionHeader title="Invitation link" />
          {link ? (
            <>
              <LinkQrCode
                payload={buildInviteUrl(webAppUrl, link.token)}
                label={`Invitation QR code for ${channel.name}`}
              />
              <Button
                title="Share link"
                icon="share"
                onPress={() => {
                  void Share.share({
                    title: `Join ${channel.name} on OGC`,
                    message: buildInviteUrl(webAppUrl, link.token),
                  });
                }}
              />
            </>
          ) : (
            <Button
              title="Create invitation link"
              variant="secondary"
              icon="link"
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

      <SectionHeader title={channel.canModerate ? 'Members' : 'People who run this channel'} />
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
            <Avatar url={m.profile.avatarUrl} name={m.profile.displayName} size={36} />
            <Text style={[social.menuText, { flex: 1 }]} numberOfLines={1}>
              {m.profile.displayName}
            </Text>
            <Tag label={m.role.toLowerCase()} tone={m.role === 'MEMBER' ? 'neutral' : 'accent'} />
          </Pressable>
        );
      })}

      {channel.canModerate ? (
        <>
          <SectionHeader title="Join requests" />
          {requests.length === 0 ? <Text style={social.muted}>No pending requests.</Text> : null}
          {requests.map((r) => (
            <View key={r.profile.ogcId} style={social.listItem}>
              <Avatar url={r.profile.avatarUrl} name={r.profile.displayName} size={36} />
              <Text style={[social.menuText, { flex: 1 }]} numberOfLines={1}>
                {r.profile.displayName}
              </Text>
              <Button
                title="Reject"
                variant="ghost"
                compact
                onPress={() => {
                  run(api.channels.decideRequest(channel.id, r.profile.ogcId, false));
                }}
              />
              <Button
                title="Approve"
                compact
                onPress={() => {
                  run(api.channels.decideRequest(channel.id, r.profile.ogcId, true));
                }}
              />
            </View>
          ))}
          <SectionHeader title="Reports" />
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
          <SectionHeader title="Moderation history" />
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
          variant="danger"
          icon="logout"
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

const NOTIFICATION_ICON: Record<NotificationView['type'], IconName> = {
  GROUP_INVITATION: 'inbox',
  GROUP_MEMBER_ADDED: 'userCheck',
  GROUP_MEMBER_REMOVED: 'community',
  GROUP_ROLE_CHANGED: 'shield',
  GROUP_DETAILS_CHANGED: 'edit',
  MENTION: 'at',
  CHANNEL_ANNOUNCEMENT: 'megaphone',
  CHANNEL_ROLE_CHANGED: 'shield',
  CHANNEL_JOIN_REQUEST: 'userPlus',
  CHANNEL_REQUEST_APPROVED: 'check',
  CHANNEL_MEMBER_REMOVED: 'hash',
  MODERATION_RESULT: 'flag',
  INVITATION_EXPIRED: 'clock',
};

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
/** "Today", "Yesterday" or the date, for grouping notifications by day. */
function dayLabel(iso: string, now: Date): string {
  const date = new Date(iso);
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(now) - start(date)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

/**
 * Group and channel activity grouped by day, plus what is waiting elsewhere (contact requests,
 * missed calls). Opening it marks everything read, as the service supports.
 */
export function NotificationsScreen() {
  const nav = useNavigation();
  const api = useCommunity();
  const { client } = useAuth();
  const { setNotificationsUnread } = useMessaging();
  const { calls } = useRecentCalls();
  const [items, setItems] = useState<NotificationView[]>();
  const [error, setError] = useState<string>();
  const [pendingRequests, setPendingRequests] = useState(0);
  const missedCalls = calls?.filter(isMissedCall).length ?? 0;
  const days = useMemo(() => {
    const now = new Date();
    const grouped = new Map<string, NotificationView[]>();
    for (const n of items ?? []) {
      const label = dayLabel(n.createdAt, now);
      grouped.set(label, [...(grouped.get(label) ?? []), n]);
    }
    return [...grouped.entries()];
  }, [items]);

  useEffect(() => {
    let active = true;
    client.incomingRequests().then(
      (page) => {
        if (active) setPendingRequests(page.items.length);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [client]);
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
    <Screen
      title="Notifications"
      subtitle="Notifications never include message text."
      onBack={nav.back}
      actions={
        <IconButton
          icon="settings"
          label="Notification settings"
          onPress={() => {
            nav.push({ name: 'notification-settings' });
          }}
        />
      }
    >
      {pendingRequests > 0 || missedCalls > 0 ? (
        <ListGroup>
          {pendingRequests > 0 ? (
            <ListRow
              icon="userPlus"
              tone="accent"
              title={`${String(pendingRequests)} contact ${pendingRequests === 1 ? 'request' : 'requests'}`}
              subtitle="Waiting for your answer"
              onPress={() => {
                nav.push({ name: 'contacts', tab: 'requests' });
              }}
            />
          ) : null}
          {missedCalls > 0 ? (
            <ListRow
              icon="phoneOff"
              tone="danger"
              title={`${String(missedCalls)} missed ${missedCalls === 1 ? 'call' : 'calls'}`}
              subtitle="In your recent calls"
              onPress={() => {
                nav.push({ name: 'calls' });
              }}
            />
          ) : null}
        </ListGroup>
      ) : null}
      {error ? <Notice>{error}</Notice> : null}
      {!items && !error ? (
        <View style={styles.surface}>
          <SkeletonRows count={4} label="Loading notifications" />
        </View>
      ) : null}
      {items?.length === 0 ? (
        <EmptyState
          icon="bell"
          title="You’re all caught up."
          body="Invitations, mentions and channel announcements appear here."
        />
      ) : null}
      {days.map(([label, list]) => (
        <View key={label} style={styles.day}>
          <SectionHeader title={label} />
          <ListGroup>
            {list.map((n) => (
              <Pressable
                key={n.id}
                style={({ pressed }) => [styles.notification, pressed && styles.postPressed]}
                accessibilityRole="button"
                accessibilityLabel={`${describe(n)}${n.readAt ? '' : ', new'}`}
                onPress={() => {
                  const channelId =
                    typeof n.data.channelId === 'string' ? n.data.channelId : undefined;
                  const conversationId =
                    typeof n.data.conversationId === 'string' ? n.data.conversationId : undefined;
                  if (n.type === 'GROUP_INVITATION') nav.push({ name: 'invitations' });
                  else if (channelId) nav.push({ name: 'channel', channelId });
                  else if (conversationId) nav.push({ name: 'conversation', conversationId });
                }}
              >
                <View
                  style={[styles.notificationIcon, n.readAt ? null : styles.notificationIconNew]}
                >
                  <Icon
                    name={NOTIFICATION_ICON[n.type]}
                    size={18}
                    tint={n.readAt ? color.textSecondary : color.accent}
                  />
                </View>
                <View style={social.names}>
                  <Text
                    style={[styles.notificationText, n.readAt ? null : styles.notificationTextNew]}
                  >
                    {describe(n)}
                  </Text>
                  <Text style={styles.when}>{listTime(n.createdAt)}</Text>
                </View>
                {n.readAt ? null : <View style={styles.unreadDot} />}
              </Pressable>
            ))}
          </ListGroup>
        </View>
      ))}
    </Screen>
  );
}

const styles = themedStyles(() =>
  StyleSheet.create({
    day: { gap: space[2] },
    surface: {
      backgroundColor: color.surface,
      borderWidth: 1,
      borderColor: color.border,
      borderRadius: radius.lg,
    },
    channelHead: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
    channelTags: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
    post: {
      gap: space[3],
      padding: space[4],
      backgroundColor: color.surface,
      borderWidth: 1,
      borderColor: color.border,
      borderRadius: radius.lg,
    },
    announcement: { borderColor: color.accentBorder, backgroundColor: color.accentSubtle },
    postPressed: { backgroundColor: color.surfaceRaised },
    author: { color: color.textPrimary, fontSize: fontSize.md, fontWeight: fontWeight.semibold },
    when: { color: color.textMuted, fontSize: fontSize.xs },
    tags: { flexDirection: 'row', gap: space[2] },
    postFooter: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space[2] },
    reaction: {
      paddingHorizontal: space[2],
      paddingVertical: 2,
      color: color.textSecondary,
      fontSize: fontSize.sm,
      backgroundColor: color.surfaceRaised,
      borderRadius: radius.full,
      overflow: 'hidden',
    },
    reactionMine: { backgroundColor: color.accentSubtle, color: color.accentHighlight },
    replies: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 'auto' },
    repliesText: { color: color.textMuted, fontSize: fontSize.sm },
    composer: { gap: space[2] },
    composerInput: { minHeight: 96 },
    notification: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space[3],
      paddingHorizontal: space[4],
      paddingVertical: space[3],
    },
    notificationIcon: {
      width: 38,
      height: 38,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: color.surfaceRaised,
      borderRadius: 19,
    },
    notificationIconNew: { backgroundColor: color.accentSubtle },
    notificationText: { color: color.textSecondary, fontSize: fontSize.md, lineHeight: 21 },
    notificationTextNew: { color: color.textPrimary, fontWeight: fontWeight.semibold },
    unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.accent },
  }),
);
