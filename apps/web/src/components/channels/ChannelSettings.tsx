import type {
  ChannelMemberView,
  ChannelPostReportView,
  ChannelView,
  ModerationActionView,
} from '@ogc/types';
import {
  CHANNEL_DESCRIPTION_MAX_LENGTH,
  COMMUNITY_NAME_MAX_LENGTH,
  canActOnMember,
  canAssignRole,
  canChangePolicies,
  canEditDetails,
  canManageInviteLinks,
} from '@ogc/validation';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { channelsApi } from '../../lib/community-api';
import { useMessaging } from '../../messaging/messaging-context';
import { Avatar } from '../Avatar';
import { InviteLinks } from '../groups/InviteLinks';
import { Modal } from '../messaging/Modal';
import styles from '../messaging/messaging.module.css';
import { Alert } from '../ui';

type Tab = 'settings' | 'members' | 'requests' | 'reports' | 'history';

const ACTION_LABEL: Record<ModerationActionView['action'], string> = {
  REMOVE_POST: 'removed a post',
  RESTORE_POST: 'restored a post',
  SUSPEND: 'suspended',
  UNSUSPEND: 'lifted the suspension of',
  BAN: 'banned',
  UNBAN: 'unbanned',
  REMOVE_MEMBER: 'removed',
  ROLE_CHANGED: 'changed the role of',
  APPROVE_MEMBER: 'approved',
  REJECT_MEMBER: 'rejected',
  RESOLVE_REPORT: 'resolved a report',
  DISMISS_REPORT: 'dismissed a report',
  PIN_POST: 'pinned a post',
  UNPIN_POST: 'unpinned a post',
  VISIBILITY_CHANGED: 'changed visibility',
  OWNERSHIP_TRANSFERRED: 'transferred ownership to',
  ARCHIVED: 'archived the channel',
  UNARCHIVED: 'restored the channel',
};

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Something went wrong.';
}

/**
 * Channel settings for members, and management and moderation tools for
 * moderators and admins. The server enforces every permission.
 */
export function ChannelSettings({
  channel,
  onChanged,
  onClose,
}: {
  channel: ChannelView;
  onChanged: () => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { engine } = useMessaging();
  const role = channel.membership?.role ?? 'MEMBER';
  const moderator = channel.canModerate;
  const [tab, setTab] = useState<Tab>('settings');
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [name, setName] = useState(channel.name);
  const [description, setDescription] = useState(channel.description ?? '');
  const [members, setMembers] = useState<ChannelMemberView[]>([]);
  const [requests, setRequests] = useState<ChannelMemberView[]>([]);
  const [bans, setBans] = useState<ChannelMemberView[]>([]);
  const [reports, setReports] = useState<ChannelPostReportView[]>([]);
  const [history, setHistory] = useState<ModerationActionView[]>([]);
  const [visibilityConfirm, setVisibilityConfirm] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const load = async () => {
      if (tab === 'members') {
        setMembers((await channelsApi.members(channel.id, {}, signal)).items);
        if (moderator)
          setBans((await channelsApi.members(channel.id, { status: 'BANNED' }, signal)).items);
      }
      if (tab === 'requests') {
        setRequests((await channelsApi.members(channel.id, { status: 'PENDING' }, signal)).items);
      }
      if (tab === 'reports') setReports((await channelsApi.reports(channel.id, signal)).items);
      if (tab === 'history') setHistory((await channelsApi.history(channel.id, signal)).items);
    };
    load().catch((cause: unknown) => {
      if (!signal.aborted) setError(describe(cause));
    });
    return () => {
      controller.abort();
    };
  }, [tab, channel.id, moderator, reload]);

  const run = (task: Promise<unknown>, success?: string) => {
    setError(undefined);
    setNotice(undefined);
    task.then(
      () => {
        if (success) setNotice(success);
        setReload((n) => n + 1);
        onChanged();
      },
      (cause: unknown) => {
        setError(describe(cause));
      },
    );
  };

  const tabs: Tab[] = moderator
    ? ['settings', 'members', 'requests', 'reports', 'history']
    : ['settings', 'members'];

  return (
    <Modal title={`${channel.name} — ${moderator ? 'manage' : 'settings'}`} onClose={onClose}>
      <div className={styles.tabs} role="tablist" aria-label="Sections">
        {tabs.map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={tab === value ? styles.segmentActive : styles.segment}
            onClick={() => {
              setTab(value);
            }}
          >
            {value[0]?.toUpperCase()}
            {value.slice(1)}
          </button>
        ))}
      </div>
      {error ? <Alert>{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <div className={styles.infoScroll}>
        {tab === 'settings' ? (
          <>
            <section className={styles.infoSection}>
              <h3 className={styles.sectionLabel}>Notifications</h3>
              <select
                className={styles.select}
                aria-label="Notify me about"
                defaultValue={channel.membership?.notificationLevel ?? 'ALL'}
                onChange={(event) => {
                  run(
                    channelsApi.setPreferences(channel.id, {
                      level: event.target.value as 'ALL' | 'MENTIONS' | 'NONE',
                    }),
                    'Saved.',
                  );
                }}
              >
                <option value="ALL">Announcements and mentions</option>
                <option value="MENTIONS">Only mentions</option>
                <option value="NONE">Nothing</option>
              </select>
            </section>
            {canEditDetails(role) && !channel.archived ? (
              <section className={styles.infoSection}>
                <h3 className={styles.sectionLabel}>Details</h3>
                <form
                  className={styles.formStack}
                  onSubmit={(event) => {
                    event.preventDefault();
                    run(
                      channelsApi.update(channel.id, {
                        name: name.trim(),
                        description: description.trim() || null,
                      }),
                      'Details saved.',
                    );
                  }}
                >
                  <input
                    className={styles.search}
                    aria-label="Name"
                    value={name}
                    maxLength={COMMUNITY_NAME_MAX_LENGTH}
                    onChange={(event) => {
                      setName(event.target.value);
                    }}
                  />
                  <textarea
                    className={styles.textarea}
                    aria-label="Description"
                    value={description}
                    maxLength={CHANNEL_DESCRIPTION_MAX_LENGTH}
                    onChange={(event) => {
                      setDescription(event.target.value);
                    }}
                  />
                  <div className={styles.confirmActions}>
                    <label className={styles.smallButton}>
                      Change photo
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        className={styles.visuallyHidden}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file)
                            run(channelsApi.uploadAvatar(channel.id, file), 'Photo updated.');
                        }}
                      />
                    </label>
                    <button type="submit" className={styles.smallButton}>
                      Save
                    </button>
                  </div>
                </form>
              </section>
            ) : null}
            {canChangePolicies(role) && !channel.archived ? (
              <section className={styles.infoSection}>
                <h3 className={styles.sectionLabel}>Rules</h3>
                <label className={styles.formStack}>
                  <span>Who can write posts</span>
                  <select
                    className={styles.select}
                    value={channel.postPolicy}
                    onChange={(event) => {
                      run(
                        channelsApi.update(channel.id, {
                          postPolicy: event.target.value as 'ADMINS' | 'MODERATORS' | 'ALL_MEMBERS',
                        }),
                      );
                    }}
                  >
                    <option value="ADMINS">Admins</option>
                    <option value="MODERATORS">Moderators and admins</option>
                    <option value="ALL_MEMBERS">All members</option>
                  </select>
                </label>
                <label className={styles.formStack}>
                  <span>Joining</span>
                  <select
                    className={styles.select}
                    value={channel.joinPolicy}
                    onChange={(event) => {
                      run(
                        channelsApi.update(channel.id, {
                          joinPolicy: event.target.value as 'OPEN' | 'APPROVAL',
                        }),
                      );
                    }}
                  >
                    <option value="OPEN">Open</option>
                    <option value="APPROVAL">Moderators approve</option>
                  </select>
                </label>
                <label className={styles.checkRow}>
                  <input
                    type="checkbox"
                    checked={channel.repliesEnabled}
                    onChange={(event) => {
                      run(channelsApi.update(channel.id, { repliesEnabled: event.target.checked }));
                    }}
                  />
                  Members can reply to posts
                </label>
              </section>
            ) : null}
            {canManageInviteLinks(role) && !channel.archived ? (
              <section className={styles.infoSection}>
                <h3 className={styles.sectionLabel}>Invitation links and QR</h3>
                <InviteLinks kind="channel" id={channel.id} name={channel.name} />
              </section>
            ) : null}
            {role === 'OWNER' ? (
              <section className={styles.infoSection}>
                <h3 className={styles.sectionLabel}>Visibility</h3>
                <p className={styles.sidebarNote}>
                  This channel is {channel.visibility === 'PUBLIC' ? 'public' : 'private'}.
                </p>
                {visibilityConfirm ? (
                  <div
                    className={styles.confirm}
                    role="alertdialog"
                    aria-label="Change visibility?"
                  >
                    <p>
                      {channel.visibility === 'PUBLIC'
                        ? 'Make it private? It disappears from discovery and search; only current members can read it and new people join only with an invitation link.'
                        : 'Make it public? Anyone on OGC can find it and read all of its posts, including older ones.'}{' '}
                      Either way, posts stay readable by OGC — community channels are not end-to-end
                      encrypted.
                    </p>
                    <div className={styles.confirmActions}>
                      <button
                        type="button"
                        className={styles.linkButton}
                        onClick={() => {
                          setVisibilityConfirm(false);
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className={[styles.smallButton, styles.danger].join(' ')}
                        onClick={() => {
                          setVisibilityConfirm(false);
                          run(
                            channelsApi.changeVisibility(
                              channel.id,
                              channel.visibility === 'PUBLIC' ? 'PRIVATE' : 'PUBLIC',
                            ),
                            'Visibility changed.',
                          );
                        }}
                      >
                        I understand — change it
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className={styles.smallButton}
                    onClick={() => {
                      setVisibilityConfirm(true);
                    }}
                  >
                    Make {channel.visibility === 'PUBLIC' ? 'private' : 'public'}
                  </button>
                )}
              </section>
            ) : null}
            <section className={styles.infoSection}>
              <h3 className={styles.sectionLabel}>Leave or close</h3>
              <div className={styles.confirmActions}>
                {role !== 'OWNER' ? (
                  <button
                    type="button"
                    className={[styles.smallButton, styles.danger].join(' ')}
                    onClick={() => {
                      channelsApi.leave(channel.id).then(
                        () => {
                          onClose();
                          void navigate('/channels');
                        },
                        (cause: unknown) => {
                          setError(describe(cause));
                        },
                      );
                    }}
                  >
                    Leave channel
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className={styles.smallButton}
                      onClick={() => {
                        run(channelsApi.setArchived(channel.id, !channel.archived));
                      }}
                    >
                      {channel.archived ? 'Restore' : 'Archive'}
                    </button>
                    <input
                      className={styles.search}
                      aria-label={`Type ${channel.handle} to enable deleting`}
                      placeholder={`Type ${channel.handle} to delete`}
                      value={deleteConfirm}
                      onChange={(event) => {
                        setDeleteConfirm(event.target.value);
                      }}
                    />
                    <button
                      type="button"
                      className={[styles.smallButton, styles.danger].join(' ')}
                      disabled={deleteConfirm.trim() !== channel.handle}
                      onClick={() => {
                        channelsApi.delete(channel.id).then(
                          () => {
                            onClose();
                            void navigate('/channels');
                          },
                          (cause: unknown) => {
                            setError(describe(cause));
                          },
                        );
                      }}
                    >
                      Delete channel
                    </button>
                  </>
                )}
              </div>
            </section>
          </>
        ) : null}

        {tab === 'members' ? (
          <>
            {!moderator ? (
              <p className={styles.sidebarNote}>The people who run this channel:</p>
            ) : null}
            <ul className={styles.pickList}>
              {members.map((m) => {
                const self = m.profile.ogcId === engine?.ogcId;
                const act = !self && canActOnMember(role, m.role, 'COMMUNITY_CHANNEL');
                return (
                  <li key={m.profile.ogcId} className={styles.memberRow}>
                    <Avatar url={m.profile.avatarUrl} name={m.profile.displayName} size={28} />
                    <span className={styles.pickName}>{m.profile.displayName}</span>
                    <span className={styles.kindTag}>{m.role.toLowerCase()}</span>
                    {m.suspendedUntil && new Date(m.suspendedUntil) > new Date() ? (
                      <span className={styles.sidebarNote}>suspended</span>
                    ) : null}
                    <span className={styles.memberActions}>
                      {(['MODERATOR', 'ADMIN', 'MEMBER'] as const)
                        .filter(
                          (next) =>
                            next !== m.role &&
                            canAssignRole(role, m.role, next, 'COMMUNITY_CHANNEL', self),
                        )
                        .map((next) => (
                          <button
                            key={next}
                            type="button"
                            className={styles.linkButton}
                            onClick={() => {
                              run(channelsApi.setRole(channel.id, m.profile.ogcId, next));
                            }}
                          >
                            Make {next.toLowerCase()}
                          </button>
                        ))}
                      {act ? (
                        <>
                          <button
                            type="button"
                            className={styles.linkButton}
                            onClick={() => {
                              run(
                                channelsApi.suspend(channel.id, m.profile.ogcId, 24),
                                'Suspended for 24 hours.',
                              );
                            }}
                          >
                            Suspend 24h
                          </button>
                          <button
                            type="button"
                            className={styles.linkButton}
                            onClick={() => {
                              run(
                                channelsApi.removeMember(channel.id, m.profile.ogcId),
                                'Removed.',
                              );
                            }}
                          >
                            Remove
                          </button>
                          <button
                            type="button"
                            className={[styles.linkButton, styles.danger].join(' ')}
                            onClick={() => {
                              run(channelsApi.ban(channel.id, m.profile.ogcId), 'Banned.');
                            }}
                          >
                            Ban
                          </button>
                        </>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
            {moderator && bans.length > 0 ? (
              <>
                <h3 className={styles.sectionLabel}>Banned</h3>
                <ul className={styles.pickList}>
                  {bans.map((m) => (
                    <li key={m.profile.ogcId} className={styles.memberRow}>
                      <span className={styles.pickName}>{m.profile.displayName}</span>
                      <button
                        type="button"
                        className={styles.linkButton}
                        onClick={() => {
                          run(channelsApi.unban(channel.id, m.profile.ogcId), 'Unbanned.');
                        }}
                      >
                        Unban
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </>
        ) : null}

        {tab === 'requests' ? (
          <ul className={styles.pickList}>
            {requests.length === 0 ? (
              <p className={styles.sidebarNote}>No pending requests.</p>
            ) : null}
            {requests.map((m) => (
              <li key={m.profile.ogcId} className={styles.memberRow}>
                <Avatar url={m.profile.avatarUrl} name={m.profile.displayName} size={28} />
                <span className={styles.pickName}>{m.profile.displayName}</span>
                <span className={styles.memberActions}>
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => {
                      run(
                        channelsApi.decideRequest(channel.id, m.profile.ogcId, true),
                        'Approved.',
                      );
                    }}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => {
                      run(
                        channelsApi.decideRequest(channel.id, m.profile.ogcId, false),
                        'Rejected.',
                      );
                    }}
                  >
                    Reject
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        {tab === 'reports' ? (
          <ul className={styles.pickList}>
            {reports.length === 0 ? <p className={styles.sidebarNote}>No open reports.</p> : null}
            {reports.map((r) => (
              <li key={r.id} className={styles.reportRow}>
                <p className={styles.sidebarNote}>
                  {r.category.replaceAll('_', ' ').toLowerCase()} · reported by{' '}
                  {r.reporter?.displayName ?? 'a former member'}
                  {r.description ? ` — “${r.description}”` : ''}
                </p>
                <p className={styles.disclosure}>
                  {r.post.body ?? r.post.removedBody ?? '(no text)'}
                </p>
                <div className={styles.confirmActions}>
                  <button
                    type="button"
                    className={[styles.smallButton, styles.danger].join(' ')}
                    onClick={() => {
                      run(
                        channelsApi.resolveReport(r.id, { outcome: 'RESOLVED', removePost: true }),
                        'Post removed and report resolved.',
                      );
                    }}
                  >
                    Remove post
                  </button>
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => {
                      run(channelsApi.resolveReport(r.id, { outcome: 'DISMISSED' }), 'Dismissed.');
                    }}
                  >
                    Dismiss
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        {tab === 'history' ? (
          <ul className={styles.pickList}>
            {history.length === 0 ? <p className={styles.sidebarNote}>No moderation yet.</p> : null}
            {history.map((h) => (
              <li key={h.id} className={styles.memberRow}>
                <span>
                  {h.moderator?.displayName ?? 'A former moderator'} {ACTION_LABEL[h.action]}
                  {h.target ? ` ${h.target.displayName}` : ''}
                  {h.reason ? ` — “${h.reason}”` : ''}
                </span>
                <time className={styles.rowTime} dateTime={h.createdAt}>
                  {new Date(h.createdAt).toLocaleString()}
                </time>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Modal>
  );
}
