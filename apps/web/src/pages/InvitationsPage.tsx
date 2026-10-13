import type { ReceivedInvitationView } from '@ogc/types';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { AppShell } from '../components/AppShell';
import { Avatar } from '../components/Avatar';
import styles from '../components/messaging/messaging.module.css';
import { Alert, Button, Spinner } from '../components/ui';
import { groupsApi } from '../lib/community-api';
import { useMessaging } from '../messaging/messaging-context';

/** `/invitations`: group and encrypted-channel invitations waiting for the user. */
export function InvitationsPage() {
  const navigate = useNavigate();
  const { engine, invitationsRevision } = useMessaging();
  const [invitations, setInvitations] = useState<ReceivedInvitationView[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    groupsApi.receivedInvitations(controller.signal).then(setInvitations, () => {
      if (!controller.signal.aborted) setError('Invitations could not be loaded.');
    });
    return () => {
      controller.abort();
    };
  }, [invitationsRevision]);

  const respond = (invitation: ReceivedInvitationView, accept: boolean) => {
    setBusy(invitation.id);
    setError(undefined);
    const task = accept
      ? groupsApi.acceptInvitation(invitation.id).then(async ({ conversationId }) => {
          await engine?.refreshConversations();
          void navigate(`/messages/${conversationId}`);
        })
      : groupsApi.declineInvitation(invitation.id).then(() => {
          setInvitations((current) => current?.filter((i) => i.id !== invitation.id));
        });
    task.then(
      () => {
        setBusy(undefined);
      },
      (cause: unknown) => {
        setBusy(undefined);
        setError(cause instanceof Error ? cause.message : 'That did not work. Please try again.');
      },
    );
  };

  return (
    <AppShell title="Invitations">
      {error ? <Alert>{error}</Alert> : null}
      {!invitations && !error ? <Spinner label="Loading invitations" /> : null}
      {invitations?.length === 0 ? (
        <p className={styles.sidebarNote}>No invitations right now.</p>
      ) : null}
      <ul className={styles.cardList}>
        {invitations?.map((invitation) => (
          <li key={invitation.id} className={styles.card}>
            <Avatar url={invitation.avatarUrl} name={invitation.name} size={48} />
            <div className={styles.cardBody}>
              <p className={styles.emptyTitle}>{invitation.name}</p>
              <p className={styles.sidebarNote}>
                {invitation.kind === 'CHANNEL' ? 'Encrypted channel' : 'Group'} ·{' '}
                {invitation.memberCount} {invitation.memberCount === 1 ? 'member' : 'members'} ·
                invited by {invitation.inviter?.displayName ?? 'a former member'} · expires{' '}
                {new Date(invitation.expiresAt).toLocaleDateString()}
              </p>
              <p className={styles.sidebarNote}>
                Messages are end-to-end encrypted. You’ll see messages sent after you join.
              </p>
            </div>
            <div className={styles.cardActions}>
              <Button
                busy={busy === invitation.id}
                onClick={() => {
                  respond(invitation, true);
                }}
              >
                Join
              </Button>
              <Button
                variant="secondary"
                disabled={busy === invitation.id}
                onClick={() => {
                  respond(invitation, false);
                }}
              >
                Decline
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </AppShell>
  );
}
