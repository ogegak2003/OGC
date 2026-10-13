import type { ChannelPostView, ChannelView, ReactionType } from '@ogc/types';
import { CHANNEL_POST_MAX_LENGTH } from '@ogc/validation';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { AppShell } from '../components/AppShell';
import { Avatar } from '../components/Avatar';
import { type PostActions, PostCard } from '../components/channels/PostCard';
import { Modal } from '../components/messaging/Modal';
import styles from '../components/messaging/messaging.module.css';
import { Alert, Button, Spinner } from '../components/ui';
import { channelsApi } from '../lib/community-api';
import { attachmentKind, safeFileName, safeMime } from '../messaging/format';
import { useMessaging } from '../messaging/messaging-context';

const ChannelSettings = lazy(() =>
  import('../components/channels/ChannelSettings').then((m) => ({ default: m.ChannelSettings })),
);

function describe(cause: unknown): string {
  const { code, status } = cause as { code?: string; status?: number };
  if (code === 'SUSPENDED') return 'You are suspended from posting in this channel for now.';
  if (code === 'ARCHIVED') return 'This channel is archived and read-only.';
  if (status === 429) return 'You’re posting too quickly. Please wait a moment.';
  return cause instanceof Error ? cause.message : 'Something went wrong.';
}

function PostComposer({
  channel,
  replyTo,
  editing,
  onDone,
  onCancel,
}: {
  channel: ChannelView;
  replyTo?: ChannelPostView | undefined;
  editing?: ChannelPostView | undefined;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState(editing?.body ?? '');
  const [announcement, setAnnouncement] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const admin = channel.membership?.role === 'OWNER' || channel.membership?.role === 'ADMIN';

  return (
    <form
      className={styles.postComposer}
      onSubmit={(event) => {
        event.preventDefault();
        if (!body.trim() && files.length === 0) return;
        setBusy(true);
        setError(undefined);
        const run = async () => {
          if (editing) {
            await channelsApi.editPost(editing.id, body.trim());
            return;
          }
          const attachmentIds: string[] = [];
          for (const file of files) {
            const uploaded = await channelsApi.uploadMedia(channel.id, file, {
              kind: attachmentKind(file.type),
              name: safeFileName(file.name),
              mime: safeMime(file.type || 'application/octet-stream'),
            });
            attachmentIds.push(uploaded.id);
          }
          await channelsApi.post(channel.id, {
            clientPostId: crypto.randomUUID(),
            ...(body.trim() ? { body: body.trim() } : {}),
            ...(replyTo ? { replyToId: replyTo.id } : {}),
            ...(announcement && !replyTo ? { announcement: true } : {}),
            ...(attachmentIds.length ? { attachmentIds } : {}),
          });
        };
        run().then(
          () => {
            setBusy(false);
            setBody('');
            setFiles([]);
            setAnnouncement(false);
            onDone();
          },
          (cause: unknown) => {
            setBusy(false);
            setError(describe(cause));
          },
        );
      }}
    >
      <label className={styles.visuallyHidden} htmlFor={`compose-${replyTo?.id ?? 'top'}`}>
        {replyTo ? 'Reply' : editing ? 'Edit post' : 'Write a post'}
      </label>
      <textarea
        id={`compose-${replyTo?.id ?? 'top'}`}
        className={styles.textarea}
        value={body}
        maxLength={CHANNEL_POST_MAX_LENGTH}
        placeholder={replyTo ? 'Write a reply…' : 'Write a post…'}
        onChange={(event) => {
          setBody(event.target.value);
        }}
      />
      {error ? <Alert>{error}</Alert> : null}
      <div className={styles.confirmActions}>
        {!editing ? (
          <label className={styles.smallButton}>
            Attach
            <input
              type="file"
              multiple
              className={styles.visuallyHidden}
              onChange={(event) => {
                setFiles([...(event.target.files ?? [])].slice(0, 10));
              }}
            />
          </label>
        ) : null}
        {files.length ? <span className={styles.sidebarNote}>{files.length} file(s)</span> : null}
        {admin && !replyTo && !editing ? (
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={announcement}
              onChange={(event) => {
                setAnnouncement(event.target.checked);
              }}
            />
            Announcement (notifies members)
          </label>
        ) : null}
        {onCancel ? (
          <button type="button" className={styles.linkButton} onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        <button type="submit" className={styles.newButton} disabled={busy}>
          {busy ? 'Sending…' : editing ? 'Save' : replyTo ? 'Reply' : 'Post'}
        </button>
      </div>
    </form>
  );
}

/** `/channels/:channelId`: a community channel's feed, threads and tools. */
export function ChannelPage() {
  const { channelId = '' } = useParams();
  const { engine, channelRevision } = useMessaging();
  const revision = channelRevision[channelId] ?? 0;
  const [channel, setChannel] = useState<ChannelView>();
  const [posts, setPosts] = useState<ChannelPostView[]>();
  const [pinned, setPinned] = useState<ChannelPostView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [thread, setThread] = useState<{ post: ChannelPostView; replies: ChannelPostView[] }>();
  const [editing, setEditing] = useState<ChannelPostView>();
  const [reporting, setReporting] = useState<ChannelPostView>();
  const [moderating, setModerating] = useState<ChannelPostView>();
  const [reason, setReason] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string>();
  const [missing, setMissing] = useState(false);
  const [reload, setReload] = useState(0);

  const refresh = useCallback(() => {
    setReload((n) => n + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      const [view, feed, pins] = await Promise.all([
        channelsApi.get(channelId, controller.signal),
        channelsApi.posts(
          channelId,
          search.trim().length >= 2 ? { q: search.trim() } : {},
          controller.signal,
        ),
        channelsApi.pinned(channelId, controller.signal),
      ]);
      setChannel(view);
      setPosts(feed.items);
      setCursor(feed.nextCursor);
      setPinned(pins);
      const newest = feed.items[0]?.seq ?? 0;
      if (view.membership?.status === 'ACTIVE' && view.unreadCount > 0 && newest > 0) {
        await channelsApi.markRead(channelId, view.version);
      }
    };
    load().catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      if ((cause as { status?: number }).status === 404) setMissing(true);
      else setError(describe(cause));
    });
    return () => {
      controller.abort();
    };
  }, [channelId, revision, reload, search]);

  const threadId = thread?.post.id;
  useEffect(() => {
    if (!threadId) return;
    const controller = new AbortController();
    channelsApi.thread(threadId, controller.signal).then(
      (result) => {
        setThread({ post: result.post, replies: result.replies.items });
      },
      () => undefined,
    );
    return () => {
      controller.abort();
    };
    // Also refreshed when the channel changes (realtime) or after an action.
  }, [threadId, revision, reload]);

  if (missing) {
    return (
      <AppShell title="Channel">
        <Alert>This channel doesn’t exist or isn’t available to you.</Alert>
        <Link to="/channels" className={styles.primaryLink}>
          Back to channels
        </Link>
      </AppShell>
    );
  }
  if (!channel) {
    return (
      <AppShell title="Channel">
        {error ? <Alert>{error}</Alert> : <Spinner label="Loading channel" />}
      </AppShell>
    );
  }

  const member = channel.membership?.status === 'ACTIVE';
  const run = (task: Promise<unknown>) => {
    setError(undefined);
    task.then(refresh, (cause: unknown) => {
      setError(describe(cause));
    });
  };
  const actions: PostActions = {
    react: (post: ChannelPostView, reaction: ReactionType, add: boolean) => {
      run(channelsApi.react(post.id, reaction, add));
    },
    openThread: (post) => {
      setThread({ post, replies: [] });
    },
    edit: setEditing,
    remove: (post) => {
      run(channelsApi.deletePost(post.id));
    },
    moderate: (post, removed) => {
      if (removed) {
        setReason('');
        setModerating(post);
      } else {
        run(channelsApi.moderatePost(post.id, false));
      }
    },
    pin: (post, pin) => {
      run(channelsApi.pin(post.id, pin));
    },
    report: setReporting,
  };
  const myId = engine?.ogcId;
  const card = (post: ChannelPostView) => (
    <PostCard
      key={post.id}
      post={post}
      mine={post.author?.ogcId === myId}
      canModerate={channel.canModerate}
      canReact={member && !channel.archived}
      actions={actions}
    />
  );

  return (
    <AppShell title={channel.name}>
      <header className={styles.channelHeader}>
        <Avatar url={channel.avatarUrl} name={channel.name} size={56} />
        <div className={styles.cardBody}>
          <p className={styles.emptyTitle}>{channel.name}</p>
          <p className={styles.sidebarNote}>
            @{channel.handle} · {channel.memberCount}{' '}
            {channel.memberCount === 1 ? 'member' : 'members'} ·{' '}
            {channel.visibility === 'PUBLIC' ? 'Public' : 'Private'} · Not end-to-end encrypted
          </p>
          {channel.description ? <p className={styles.rowPreview}>{channel.description}</p> : null}
        </div>
        <div className={styles.cardActions}>
          {!channel.membership ? (
            <Button
              onClick={() => {
                run(channelsApi.join(channel.id));
              }}
            >
              {channel.joinPolicy === 'APPROVAL' ? 'Request to join' : 'Join'}
            </Button>
          ) : null}
          {channel.membership?.status === 'PENDING' ? (
            <Button
              variant="secondary"
              onClick={() => {
                run(channelsApi.leave(channel.id));
              }}
            >
              Withdraw request
            </Button>
          ) : null}
          {member ? (
            <Button
              variant="secondary"
              onClick={() => {
                setShowSettings(true);
              }}
            >
              {channel.canModerate ? 'Manage' : 'Settings'}
            </Button>
          ) : null}
        </div>
      </header>
      <p className={styles.sidebarNote}>
        Posts in community channels can be read by OGC for moderation and search. Don’t share
        secrets here.
      </p>
      {channel.archived ? <Alert tone="info">This channel is archived and read-only.</Alert> : null}
      {channel.membership?.suspendedUntil &&
      new Date(channel.membership.suspendedUntil) > new Date() ? (
        <Alert tone="info">
          A moderator suspended your posting until{' '}
          {new Date(channel.membership.suspendedUntil).toLocaleString()}.
        </Alert>
      ) : null}
      {error ? <Alert>{error}</Alert> : null}

      {pinned.length > 0 ? (
        <section aria-label="Pinned posts" className={styles.pinned}>
          <h2 className={styles.sectionLabel}>Pinned</h2>
          {pinned.map(card)}
        </section>
      ) : null}

      {channel.canPost ? (
        <PostComposer channel={channel} onDone={refresh} />
      ) : member && !channel.archived ? (
        <p className={styles.sidebarNote}>
          {channel.postPolicy === 'ADMINS'
            ? 'Admins write posts here; you can reply and react.'
            : 'Moderators and admins write posts here; you can reply and react.'}
        </p>
      ) : null}

      <input
        type="search"
        className={styles.search}
        placeholder="Search this channel"
        aria-label="Search this channel’s posts"
        value={search}
        maxLength={64}
        onChange={(event) => {
          setSearch(event.target.value);
        }}
      />
      <section aria-label="Posts" className={styles.feed}>
        {posts === undefined ? <Spinner label="Loading posts" /> : null}
        {posts?.length === 0 ? <p className={styles.sidebarNote}>No posts yet.</p> : null}
        {posts?.map(card)}
      </section>
      {cursor ? (
        <Button
          variant="secondary"
          onClick={() => {
            channelsApi.posts(channel.id, { before: Number(cursor) }).then(
              (page) => {
                setPosts((current) => [...(current ?? []), ...page.items]);
                setCursor(page.nextCursor);
              },
              (cause: unknown) => {
                setError(describe(cause));
              },
            );
          }}
        >
          Older posts
        </Button>
      ) : null}

      {thread ? (
        <Modal
          title="Discussion"
          onClose={() => {
            setThread(undefined);
          }}
        >
          <div className={styles.infoScroll}>
            {card(thread.post)}
            {thread.replies.map(card)}
            {channel.canReply ? (
              <PostComposer channel={channel} replyTo={thread.post} onDone={refresh} />
            ) : null}
          </div>
        </Modal>
      ) : null}
      {editing ? (
        <Modal
          title="Edit post"
          onClose={() => {
            setEditing(undefined);
          }}
        >
          <PostComposer
            channel={channel}
            editing={editing}
            onDone={() => {
              setEditing(undefined);
              refresh();
            }}
            onCancel={() => {
              setEditing(undefined);
            }}
          />
        </Modal>
      ) : null}
      {moderating ? (
        <Modal
          title="Remove post"
          onClose={() => {
            setModerating(undefined);
          }}
        >
          <form
            className={styles.formStack}
            onSubmit={(event) => {
              event.preventDefault();
              const target = moderating;
              setModerating(undefined);
              run(channelsApi.moderatePost(target.id, true, reason.trim() || undefined));
            }}
          >
            <p className={styles.sidebarNote}>
              Members will see “Removed by a moderator”. Moderators can still review and restore it.
              The action and reason are recorded in the moderation history.
            </p>
            <textarea
              className={styles.textarea}
              aria-label="Reason (recorded in the moderation history)"
              maxLength={500}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
            <button type="submit" className={[styles.smallButton, styles.danger].join(' ')}>
              Remove post
            </button>
          </form>
        </Modal>
      ) : null}
      {reporting ? (
        <ReportPostDialog
          post={reporting}
          onClose={() => {
            setReporting(undefined);
          }}
        />
      ) : null}
      {showSettings ? (
        <Suspense fallback={<Spinner label="Loading settings" />}>
          <ChannelSettings
            channel={channel}
            onChanged={refresh}
            onClose={() => {
              setShowSettings(false);
            }}
          />
        </Suspense>
      ) : null}
    </AppShell>
  );
}

function ReportPostDialog({ post, onClose }: { post: ChannelPostView; onClose: () => void }) {
  const [category, setCategory] = useState('SPAM');
  const [description, setDescription] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <Modal title="Report post" onClose={onClose}>
      {done ? (
        <Alert tone="success">Thanks — the channel’s moderators will review it.</Alert>
      ) : (
        <form
          className={styles.formStack}
          onSubmit={(event) => {
            event.preventDefault();
            channelsApi
              .reportPost(post.id, {
                category,
                ...(description.trim() ? { description: description.trim() } : {}),
              })
              .then(
                () => {
                  setDone(true);
                },
                (cause: unknown) => {
                  setError(describe(cause));
                },
              );
          }}
        >
          <select
            className={styles.select}
            aria-label="Reason"
            value={category}
            onChange={(event) => {
              setCategory(event.target.value);
            }}
          >
            <option value="SPAM">Spam</option>
            <option value="HARASSMENT">Harassment</option>
            <option value="IMPERSONATION">Impersonation</option>
            <option value="INAPPROPRIATE_CONTENT">Inappropriate content</option>
            <option value="SCAM_OR_FRAUD">Scam or fraud</option>
            <option value="OTHER">Something else</option>
          </select>
          <textarea
            className={styles.textarea}
            aria-label="Details (optional)"
            maxLength={1000}
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
          {error ? <Alert>{error}</Alert> : null}
          <button type="submit" className={styles.newButton}>
            Send report
          </button>
        </form>
      )}
    </Modal>
  );
}
