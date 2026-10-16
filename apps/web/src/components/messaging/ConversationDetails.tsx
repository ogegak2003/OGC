import { conversationAvatar, conversationTitle } from '@ogc/messaging';
import type { ConversationView, GroupMemberView } from '@ogc/types';
import { formatOgcIdForDisplay } from '@ogc/validation';
import { Suspense, lazy, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../lib/api';
import { groupsApi } from '../../lib/community-api';
import { errorMessage } from '../../lib/form';
import { useMessaging } from '../../messaging/messaging-context';
import { Avatar } from '../Avatar';
import { CallButtons } from '../calls/CallButtons';
import { Icon } from '../Icon';
import { Alert, Button, Spinner } from '../ui';
import { SafetyNumberDialog } from './Dialogs';
import styles from './details.module.css';

const GroupInfoPanel = lazy(() =>
  import('../groups/GroupInfoPanel').then((m) => ({ default: m.GroupInfoPanel })),
);

/** Members shown in the panel before "Group settings". */
const MEMBER_PREVIEW = 8;

/**
 * The details panel beside an open conversation (wide screens) or over it (narrow ones). For a
 * direct conversation: who the person is, calls, safety-number verification, and block or
 * report. For a group or private channel: what it is, its members, and the existing settings
 * dialog for everything managers can change. Every action uses the same API and rules as the
 * rest of the app.
 */
export function ConversationDetails({
  conversation,
  onClose,
}: {
  conversation: ConversationView;
  onClose: () => void;
}) {
  const { engine } = useMessaging();
  const title = conversationTitle(conversation);
  const avatar = conversationAvatar(conversation);
  const peer = conversation.peer;
  const group = conversation.group;
  const [verifying, setVerifying] = useState(false);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [members, setMembers] = useState<GroupMemberView[]>();
  const [managing, setManaging] = useState(false);

  useEffect(() => {
    if (!group) return;
    const controller = new AbortController();
    groupsApi.members(conversation.id, controller.signal).then(setMembers, () => undefined);
    return () => {
      controller.abort();
    };
  }, [group, conversation.id, conversation.version]);

  async function run(task: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await task();
      await engine?.refreshConversations();
      setConfirmBlock(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className={styles.details} aria-label={`Details: ${title}`}>
      <header className={styles.header}>
        <h2 className={styles.heading}>{group ? 'About' : 'Contact'}</h2>
        <button
          type="button"
          className={styles.close}
          onClick={onClose}
          aria-label="Close details"
          title="Close details"
        >
          <Icon name="close" size={20} />
        </button>
      </header>

      <div className={styles.identity}>
        <Avatar url={avatar.url} name={avatar.name} size={72} />
        <p className={styles.name}>{title}</p>
        {peer ? (
          <p className={styles.ogcId}>{formatOgcIdForDisplay(peer.ogcId)}</p>
        ) : group ? (
          <p className={styles.meta}>
            {group.kind === 'CHANNEL' ? 'Private channel' : 'Group'} ·{' '}
            {`${String(group.memberCount)} ${group.memberCount === 1 ? 'member' : 'members'}`}
          </p>
        ) : null}
      </div>

      {error ? <Alert>{error}</Alert> : null}

      <p className={styles.encryption}>
        <Icon name="lock" size={16} />
        End-to-end encrypted. Only the members’ devices can read these messages.
      </p>

      {peer ? (
        <>
          {conversation.blockedByMe ? null : (
            <div className={styles.calls}>
              <CallButtons conversationId={conversation.id} peer={peer} name={title} />
            </div>
          )}
          <nav className={styles.actions} aria-label="Contact actions">
            <Link to={`/id/${peer.ogcId}`} className={styles.action}>
              <Icon name="user" size={18} />
              View profile
            </Link>
            <button
              type="button"
              className={styles.action}
              onClick={() => {
                setVerifying(true);
              }}
            >
              <Icon name="shieldCheck" size={18} />
              Verify safety number
            </button>
            {conversation.blockedByMe ? (
              <button
                type="button"
                className={styles.action}
                disabled={busy}
                onClick={() => void run(() => api.unblock(peer.ogcId))}
              >
                <Icon name="ban" size={18} />
                Unblock {peer.displayName}
              </button>
            ) : confirmBlock ? (
              <div className={styles.confirm} role="group" aria-label="Confirm block">
                <p className={styles.confirmText}>
                  Block {peer.displayName}? They are removed as a contact and can no longer message
                  or call you. They are not told.
                </p>
                <div className={styles.confirmActions}>
                  <Button
                    variant="danger"
                    busy={busy}
                    onClick={() => void run(() => api.block(peer.ogcId))}
                  >
                    Block
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setConfirmBlock(false);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className={[styles.action, styles.danger].join(' ')}
                onClick={() => {
                  setConfirmBlock(true);
                }}
              >
                <Icon name="ban" size={18} />
                Block
              </button>
            )}
            <Link to={`/report/${peer.ogcId}`} className={[styles.action, styles.danger].join(' ')}>
              <Icon name="flag" size={18} />
              Report
            </Link>
          </nav>
        </>
      ) : group ? (
        <>
          {group.description ? <p className={styles.description}>{group.description}</p> : null}
          <section aria-labelledby="details-members" className={styles.members}>
            <h3 id="details-members" className={styles.subheading}>
              Members
            </h3>
            {members === undefined ? (
              <Spinner label="Loading members" />
            ) : (
              <ul className={styles.memberList}>
                {members.slice(0, MEMBER_PREVIEW).map((member) => (
                  <li key={member.profile.ogcId} className={styles.member}>
                    <Avatar
                      url={member.profile.avatarUrl}
                      name={member.profile.displayName}
                      size={32}
                    />
                    <span className={styles.memberName}>{member.profile.displayName}</span>
                    {member.role !== 'MEMBER' ? (
                      <span className={styles.role}>{member.role.toLowerCase()}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {members && members.length > MEMBER_PREVIEW ? (
              <p className={styles.meta}>and {members.length - MEMBER_PREVIEW} more</p>
            ) : null}
          </section>
          <Button
            variant="secondary"
            icon="settings"
            onClick={() => {
              setManaging(true);
            }}
          >
            {group.kind === 'CHANNEL' ? 'Channel settings' : 'Group settings'}
          </Button>
        </>
      ) : null}

      {verifying ? (
        <SafetyNumberDialog
          conversation={conversation}
          onClose={() => {
            setVerifying(false);
          }}
        />
      ) : null}
      {managing && group && members ? (
        <Suspense fallback={<Spinner label="Loading settings" />}>
          <GroupInfoPanel
            conversation={conversation}
            members={members}
            onMembersChanged={setMembers}
            onClose={() => {
              setManaging(false);
            }}
          />
        </Suspense>
      ) : null}
    </aside>
  );
}
