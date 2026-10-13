import type {
  ContactView,
  ConversationView,
  GroupMemberView,
  NotificationPreferences,
  SentInvitationView,
} from '@ogc/types';
import {
  COMMUNITY_NAME_MAX_LENGTH,
  GROUP_DESCRIPTION_MAX_LENGTH,
  canActOnMember,
  canArchiveOrDelete,
  canAssignRole,
  canChangePolicies,
  canEditDetails,
  canInvite,
  canManageInviteLinks,
} from '@ogc/validation';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../../lib/api';
import { groupsApi } from '../../lib/community-api';
import { useMessaging } from '../../messaging/messaging-context';
import { Avatar } from '../Avatar';
import { SafetyNumberDialog } from '../messaging/Dialogs';
import { Modal } from '../messaging/Modal';
import styles from '../messaging/messaging.module.css';
import { Alert } from '../ui';
import { InviteLinks } from './InviteLinks';

const ROLE_LABEL = { OWNER: 'Owner', ADMIN: 'Admin', MODERATOR: 'Moderator', MEMBER: 'Member' };

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Something went wrong. Please try again.';
}

/**
 * Details and management of a group or encrypted channel. Controls appear
 * only when the viewer's role allows them (the server enforces the same
 * matrix on every request).
 */
export function GroupInfoPanel({
  conversation,
  members,
  onMembersChanged,
  onClose,
}: {
  conversation: ConversationView;
  members: GroupMemberView[];
  onMembersChanged: (members: GroupMemberView[]) => void;
  onClose: () => void;
}) {
  const group = conversation.group;
  const navigate = useNavigate();
  const { engine } = useMessaging();
  const [name, setName] = useState(group?.name ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [preferences, setPreferences] = useState<NotificationPreferences>();
  const [invitations, setInvitations] = useState<SentInvitationView[]>([]);
  const [contacts, setContacts] = useState<ContactView[]>();
  const [verifying, setVerifying] = useState<{ ogcId: string; displayName: string }>();
  const [confirm, setConfirm] = useState<'leave' | 'delete' | 'archive' | null>(null);
  const [memberAction, setMemberAction] = useState<{
    kind: 'remove' | 'transfer';
    member: GroupMemberView;
  } | null>(null);
  const [typedName, setTypedName] = useState('');
  const role = group?.myRole ?? 'MEMBER';
  const kind = group?.kind === 'CHANNEL' ? 'CHANNEL' : 'GROUP';
  const noun = kind === 'CHANNEL' ? 'channel' : 'group';
  const mayInvite = group ? canInvite(role, group.invitePolicy) && !group.archived : false;
  const myOgcId = engine?.ogcId;

  useEffect(() => {
    const controller = new AbortController();
    groupsApi.preferences(conversation.id, controller.signal).then(setPreferences, () => undefined);
    if (mayInvite) {
      groupsApi
        .sentInvitations(conversation.id, controller.signal)
        .then(setInvitations, () => undefined);
    }
    return () => {
      controller.abort();
    };
  }, [conversation.id, mayInvite]);

  if (!group) return null;

  const run = (task: Promise<unknown>, success?: string) => {
    setError(undefined);
    setNotice(undefined);
    task.then(
      async () => {
        if (success) setNotice(success);
        onMembersChanged(await groupsApi.members(conversation.id));
        await engine?.refreshConversations();
      },
      (cause: unknown) => {
        setError(describeError(cause));
      },
    );
  };

  const memberIds = new Set(members.map((m) => m.profile.ogcId as string));
  const pendingIds = new Set(
    invitations.filter((i) => i.status === 'PENDING').map((i) => i.invitee.ogcId as string),
  );

  return (
    <Modal title={`${kind === 'CHANNEL' ? 'Channel' : 'Group'} info`} onClose={onClose}>
      <div className={styles.infoScroll}>
        <div className={styles.infoHeader}>
          <Avatar url={group.avatarUrl} name={group.name} size={72} />
          <div>
            <p className={styles.emptyTitle}>{group.name}</p>
            <p className={styles.sidebarNote}>
              {group.memberCount} {group.memberCount === 1 ? 'member' : 'members'} · End-to-end
              encrypted · You are {ROLE_LABEL[role].toLowerCase()}
            </p>
          </div>
        </div>
        {group.description ? <p className={styles.disclosure}>{group.description}</p> : null}
        {error ? <Alert>{error}</Alert> : null}
        {notice ? <Alert tone="success">{notice}</Alert> : null}

        {canEditDetails(role) && !group.archived ? (
          <section className={styles.infoSection} aria-labelledby="details-heading">
            <h3 id="details-heading" className={styles.sectionLabel}>
              Details
            </h3>
            <form
              className={styles.formStack}
              onSubmit={(event) => {
                event.preventDefault();
                run(
                  groupsApi.update(conversation.id, {
                    name: name.trim(),
                    description: description.trim() || null,
                  }),
                  'Details saved.',
                );
              }}
            >
              <label className={styles.formStack}>
                <span>Name</span>
                <input
                  className={styles.search}
                  value={name}
                  maxLength={COMMUNITY_NAME_MAX_LENGTH}
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                />
              </label>
              <label className={styles.formStack}>
                <span>Description</span>
                <textarea
                  className={styles.textarea}
                  value={description}
                  maxLength={GROUP_DESCRIPTION_MAX_LENGTH}
                  onChange={(event) => {
                    setDescription(event.target.value);
                  }}
                />
              </label>
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
                        run(groupsApi.uploadAvatar(conversation.id, file), 'Photo updated.');
                    }}
                  />
                </label>
                {group.avatarUrl ? (
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => {
                      run(groupsApi.removeAvatar(conversation.id), 'Photo removed.');
                    }}
                  >
                    Remove photo
                  </button>
                ) : null}
                <button type="submit" className={styles.smallButton}>
                  Save
                </button>
              </div>
            </form>
          </section>
        ) : null}

        {canChangePolicies(role) && !group.archived ? (
          <section className={styles.infoSection} aria-labelledby="policies-heading">
            <h3 id="policies-heading" className={styles.sectionLabel}>
              Permissions
            </h3>
            <label className={styles.formStack}>
              <span>Who can post</span>
              <select
                className={styles.select}
                value={group.postPolicy}
                onChange={(event) => {
                  run(
                    groupsApi.update(conversation.id, {
                      postPolicy: event.target.value as 'ALL_MEMBERS' | 'ADMINS',
                    }),
                  );
                }}
              >
                <option value="ALL_MEMBERS">Everyone</option>
                <option value="ADMINS">Admins only</option>
              </select>
            </label>
            <label className={styles.formStack}>
              <span>Who can invite</span>
              <select
                className={styles.select}
                value={group.invitePolicy}
                onChange={(event) => {
                  run(
                    groupsApi.update(conversation.id, {
                      invitePolicy: event.target.value as 'ALL_MEMBERS' | 'ADMINS',
                    }),
                  );
                }}
              >
                <option value="ADMINS">Admins only</option>
                <option value="ALL_MEMBERS">Everyone</option>
              </select>
            </label>
          </section>
        ) : null}

        <section className={styles.infoSection} aria-labelledby="notify-heading">
          <h3 id="notify-heading" className={styles.sectionLabel}>
            Notifications
          </h3>
          <select
            className={styles.select}
            aria-label="Notify me about"
            value={preferences?.level ?? 'ALL'}
            onChange={(event) => {
              const level = event.target.value as NotificationPreferences['level'];
              groupsApi
                .setPreferences(conversation.id, { level })
                .then(setPreferences, (cause: unknown) => {
                  setError(describeError(cause));
                });
            }}
          >
            <option value="ALL">All messages</option>
            <option value="MENTIONS">Only mentions</option>
            <option value="NONE">Nothing</option>
          </select>
          <div className={styles.confirmActions}>
            {preferences?.mutedUntil && new Date(preferences.mutedUntil) > new Date() ? (
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => {
                  groupsApi
                    .setPreferences(conversation.id, { mutedUntil: null })
                    .then(setPreferences, () => undefined);
                }}
              >
                Muted until {new Date(preferences.mutedUntil).toLocaleString()} — unmute
              </button>
            ) : (
              [8, 24 * 7].map((hours) => (
                <button
                  key={hours}
                  type="button"
                  className={styles.linkButton}
                  onClick={() => {
                    groupsApi
                      .setPreferences(conversation.id, {
                        mutedUntil: new Date(Date.now() + hours * 3_600_000).toISOString(),
                      })
                      .then(setPreferences, () => undefined);
                  }}
                >
                  Mute {hours === 8 ? '8 hours' : '1 week'}
                </button>
              ))
            )}
          </div>
        </section>

        <section className={styles.infoSection} aria-labelledby="members-heading">
          <h3 id="members-heading" className={styles.sectionLabel}>
            Members
          </h3>
          <ul className={styles.pickList}>
            {members.map((member) => {
              const self = member.profile.ogcId === myOgcId;
              const removable = !self && canActOnMember(role, member.role, kind);
              const promote =
                !self &&
                canAssignRole(role, member.role, 'ADMIN', kind, false) &&
                member.role !== 'ADMIN';
              const demote =
                !self &&
                canAssignRole(role, member.role, 'MEMBER', kind, false) &&
                member.role === 'ADMIN';
              return (
                <li key={member.profile.ogcId} className={styles.memberRow}>
                  <Avatar
                    url={member.profile.avatarUrl}
                    name={member.profile.displayName}
                    size={32}
                  />
                  <span className={styles.pickName}>
                    {member.profile.displayName}
                    {self ? ' (you)' : ''}
                  </span>
                  <span className={styles.kindTag}>{ROLE_LABEL[member.role]}</span>
                  <span className={styles.memberActions}>
                    {!self ? (
                      <button
                        type="button"
                        className={styles.linkButton}
                        onClick={() => {
                          setVerifying({
                            ogcId: member.profile.ogcId,
                            displayName: member.profile.displayName,
                          });
                        }}
                      >
                        Verify
                      </button>
                    ) : null}
                    {promote && !group.archived ? (
                      <button
                        type="button"
                        className={styles.linkButton}
                        onClick={() => {
                          run(groupsApi.setRole(conversation.id, member.profile.ogcId, 'ADMIN'));
                        }}
                      >
                        Make admin
                      </button>
                    ) : null}
                    {demote && !group.archived ? (
                      <button
                        type="button"
                        className={styles.linkButton}
                        onClick={() => {
                          run(groupsApi.setRole(conversation.id, member.profile.ogcId, 'MEMBER'));
                        }}
                      >
                        Remove admin
                      </button>
                    ) : null}
                    {role === 'OWNER' && !self ? (
                      <button
                        type="button"
                        className={styles.linkButton}
                        onClick={() => {
                          setMemberAction({ kind: 'transfer', member });
                        }}
                      >
                        Make owner
                      </button>
                    ) : null}
                    {removable ? (
                      <button
                        type="button"
                        className={[styles.linkButton, styles.danger].join(' ')}
                        onClick={() => {
                          setMemberAction({ kind: 'remove', member });
                        }}
                      >
                        Remove
                      </button>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
          {memberAction ? (
            <div className={styles.confirm} role="alertdialog" aria-label="Please confirm">
              <p>
                {memberAction.kind === 'remove'
                  ? `Remove ${memberAction.member.profile.displayName}? Their devices are removed from the encryption group, so they can’t read anything sent afterwards.`
                  : `Make ${memberAction.member.profile.displayName} the owner? You will become an admin.`}
              </p>
              <div className={styles.confirmActions}>
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => {
                    setMemberAction(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={[styles.smallButton, styles.danger].join(' ')}
                  onClick={() => {
                    const { kind: action, member } = memberAction;
                    setMemberAction(null);
                    run(
                      action === 'remove'
                        ? groupsApi.removeMember(conversation.id, member.profile.ogcId)
                        : groupsApi.transfer(conversation.id, member.profile.ogcId),
                      action === 'remove'
                        ? `${member.profile.displayName} was removed.`
                        : 'Ownership transferred.',
                    );
                  }}
                >
                  {memberAction.kind === 'remove' ? 'Remove' : 'Make owner'}
                </button>
              </div>
            </div>
          ) : null}
        </section>

        {mayInvite ? (
          <section className={styles.infoSection} aria-labelledby="invite-heading">
            <h3 id="invite-heading" className={styles.sectionLabel}>
              Invite contacts
            </h3>
            {contacts === undefined ? (
              <button
                type="button"
                className={styles.smallButton}
                onClick={() => {
                  api.contacts().then(
                    (page) => {
                      setContacts(page.items);
                    },
                    () => {
                      setError('Your contacts could not be loaded.');
                    },
                  );
                }}
              >
                Choose contacts
              </button>
            ) : (
              <ul className={styles.pickList}>
                {contacts
                  .filter((c) => !memberIds.has(c.profile.ogcId))
                  .map((contact) => (
                    <li key={contact.profile.ogcId} className={styles.memberRow}>
                      <Avatar
                        url={contact.profile.avatarUrl}
                        name={contact.profile.displayName}
                        size={28}
                      />
                      <span className={styles.pickName}>{contact.profile.displayName}</span>
                      {pendingIds.has(contact.profile.ogcId) ? (
                        <span className={styles.sidebarNote}>Invited</span>
                      ) : (
                        <button
                          type="button"
                          className={styles.linkButton}
                          onClick={() => {
                            groupsApi.invite(conversation.id, [contact.profile.ogcId]).then(
                              async () => {
                                setInvitations(await groupsApi.sentInvitations(conversation.id));
                              },
                              (cause: unknown) => {
                                setError(describeError(cause));
                              },
                            );
                          }}
                        >
                          Invite
                        </button>
                      )}
                    </li>
                  ))}
              </ul>
            )}
            {invitations.some((i) => i.status === 'PENDING') ? (
              <ul className={styles.pickList} aria-label="Pending invitations">
                {invitations
                  .filter((i) => i.status === 'PENDING')
                  .map((invitation) => (
                    <li key={invitation.id} className={styles.memberRow}>
                      <span className={styles.pickName}>
                        {invitation.invitee.displayName} — waiting until{' '}
                        {new Date(invitation.expiresAt).toLocaleDateString()}
                      </span>
                      <button
                        type="button"
                        className={styles.linkButton}
                        onClick={() => {
                          groupsApi.revokeInvitation(invitation.id).then(
                            async () => {
                              setInvitations(await groupsApi.sentInvitations(conversation.id));
                            },
                            (cause: unknown) => {
                              setError(describeError(cause));
                            },
                          );
                        }}
                      >
                        Revoke
                      </button>
                    </li>
                  ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {canManageInviteLinks(role) && !group.archived ? (
          <section className={styles.infoSection} aria-labelledby="links-heading">
            <h3 id="links-heading" className={styles.sectionLabel}>
              Invitation links and QR
            </h3>
            <InviteLinks kind="group" id={conversation.id} name={group.name} />
          </section>
        ) : null}

        <section className={styles.infoSection} aria-labelledby="danger-heading">
          <h3 id="danger-heading" className={styles.sectionLabel}>
            Leave or close
          </h3>
          <div className={styles.confirmActions}>
            <button
              type="button"
              className={[styles.smallButton, styles.danger].join(' ')}
              onClick={() => {
                setConfirm('leave');
              }}
            >
              Leave {noun}
            </button>
            {canArchiveOrDelete(role) ? (
              <>
                <button
                  type="button"
                  className={styles.smallButton}
                  onClick={() => {
                    setConfirm('archive');
                  }}
                >
                  {group.archived ? 'Restore' : 'Archive'}
                </button>
                <button
                  type="button"
                  className={[styles.smallButton, styles.danger].join(' ')}
                  onClick={() => {
                    setTypedName('');
                    setConfirm('delete');
                  }}
                >
                  Delete {noun}
                </button>
              </>
            ) : null}
          </div>
        </section>

        {confirm ? (
          <div className={styles.confirm} role="alertdialog" aria-label="Please confirm">
            {confirm === 'leave' ? (
              <p>
                {role === 'OWNER' && group.memberCount > 1
                  ? 'You own this group. Make another member the owner before leaving.'
                  : `Leave ${group.name}? Your devices are removed from its encryption, its messages are erased from this device, and you’ll need a new invitation to come back.`}
              </p>
            ) : null}
            {confirm === 'archive' ? (
              <p>
                {group.archived
                  ? `Restore ${group.name}? Members can post again.`
                  : `Archive ${group.name}? Everyone can still read it, but nobody can post until you restore it.`}
              </p>
            ) : null}
            {confirm === 'delete' ? (
              <>
                <p>
                  Delete {group.name} for everyone? All messages, files and encryption state are
                  removed from OGC and from members’ devices. This can’t be undone. Type the {noun}{' '}
                  name to confirm.
                </p>
                <input
                  className={styles.search}
                  aria-label={`Type ${group.name} to confirm`}
                  value={typedName}
                  onChange={(event) => {
                    setTypedName(event.target.value);
                  }}
                />
              </>
            ) : null}
            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => {
                  setConfirm(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className={[styles.smallButton, confirm === 'archive' ? '' : styles.danger].join(
                  ' ',
                )}
                disabled={
                  (confirm === 'leave' && role === 'OWNER' && group.memberCount > 1) ||
                  (confirm === 'delete' && typedName.trim() !== group.name)
                }
                onClick={() => {
                  const action = confirm;
                  setConfirm(null);
                  setError(undefined);
                  const task =
                    action === 'leave'
                      ? groupsApi.leave(conversation.id)
                      : action === 'delete'
                        ? groupsApi.delete(conversation.id)
                        : groupsApi.setArchived(conversation.id, !group.archived);
                  task.then(
                    async () => {
                      if (action === 'archive') {
                        await engine?.refreshConversations();
                        onClose();
                        return;
                      }
                      await engine?.forgetConversation(conversation.id);
                      onClose();
                      void navigate('/messages');
                    },
                    (cause: unknown) => {
                      setError(describeError(cause));
                    },
                  );
                }}
              >
                Confirm
              </button>
            </div>
          </div>
        ) : null}
      </div>
      {verifying ? (
        <SafetyNumberDialog
          conversation={conversation}
          member={verifying}
          onClose={() => {
            setVerifying(undefined);
          }}
        />
      ) : null}
    </Modal>
  );
}
