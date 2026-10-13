import type { InvitePreview } from '@ogc/types';
import { parseInviteToken } from '@ogc/validation';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { AppShell } from '../components/AppShell';
import { Avatar } from '../components/Avatar';
import styles from '../components/messaging/messaging.module.css';
import { Alert, Button, Spinner } from '../components/ui';
import { linksApi } from '../lib/community-api';
import { useMessaging } from '../messaging/messaging-context';

/**
 * `/join#token=ogc_inv_…` — opened from an invitation link or QR code. The
 * token is read from the URL fragment (never sent to servers by the browser)
 * and posted to the API in a request body. Nothing happens without a tap on
 * "Join".
 */
export function JoinPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { engine } = useMessaging();
  const token = parseInviteToken(location.hash);
  const [preview, setPreview] = useState<InvitePreview>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!token) return;
    let active = true;
    linksApi.preview(token).then(
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
  }, [token]);

  const destination = (target: InvitePreview['target'], id: string) =>
    target === 'COMMUNITY_CHANNEL' ? `/channels/${id}` : `/messages/${id}`;

  return (
    <AppShell title="Invitation">
      {!token ? <Alert>This invitation link is incomplete. Ask for a new one.</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}
      {token && !preview && !error ? <Spinner label="Checking the invitation" /> : null}
      {preview ? (
        <div className={styles.card}>
          <Avatar url={preview.avatarUrl} name={preview.name} size={64} />
          <div className={styles.cardBody}>
            <p className={styles.emptyTitle}>{preview.name}</p>
            <p className={styles.sidebarNote}>
              {preview.target === 'COMMUNITY_CHANNEL'
                ? 'Community channel'
                : preview.target === 'CHANNEL'
                  ? 'Encrypted channel'
                  : 'Group'}{' '}
              · {preview.memberCount} {preview.memberCount === 1 ? 'member' : 'members'}
            </p>
            {preview.description ? (
              <p className={styles.disclosure}>{preview.description}</p>
            ) : null}
            <p className={styles.sidebarNote}>
              {preview.endToEndEncrypted
                ? 'Messages are end-to-end encrypted for members’ devices. You’ll see messages sent after you join.'
                : 'Community channels are not end-to-end encrypted: OGC can read posts, so it can host discovery and moderation.'}
            </p>
            {preview.requiresApproval ? (
              <p className={styles.sidebarNote}>A moderator approves new members.</p>
            ) : null}
            {pending ? (
              <Alert tone="info">
                Request sent. You’ll be notified when a moderator approves it.
              </Alert>
            ) : null}
          </div>
          <div className={styles.cardActions}>
            {preview.alreadyMember ? (
              <Button
                onClick={() => {
                  void navigate(destination(preview.target, preview.id));
                }}
              >
                Open
              </Button>
            ) : (
              <Button
                busy={busy}
                disabled={pending}
                onClick={() => {
                  if (!token) return;
                  setBusy(true);
                  setError(undefined);
                  linksApi.join(token).then(
                    async (result) => {
                      setBusy(false);
                      if (result.status === 'PENDING') {
                        setPending(true);
                        return;
                      }
                      if (result.target !== 'COMMUNITY_CHANNEL') {
                        await engine?.refreshConversations();
                      }
                      void navigate(destination(result.target, result.id));
                    },
                    (cause: unknown) => {
                      setBusy(false);
                      setError(
                        cause instanceof Error
                          ? cause.message
                          : 'You could not join with this link.',
                      );
                    },
                  );
                }}
              >
                {preview.requiresApproval ? 'Request to join' : 'Join'}
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}
