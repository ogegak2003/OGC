import type { CreatedInviteLink, InviteLinkView } from '@ogc/types';
import { buildInviteUrl } from '@ogc/validation';
import { useEffect, useMemo, useState } from 'react';
import { type LinkTarget, linksApi } from '../../lib/community-api';
import styles from '../messaging/messaging.module.css';
import { QrCode } from '../QrCode';
import { Alert } from '../ui';

const EXPIRY_CHOICES = [
  { hours: 24, label: '1 day' },
  { hours: 7 * 24, label: '7 days' },
  { hours: 30 * 24, label: '30 days' },
];

function linkState(link: InviteLinkView): string {
  if (link.revokedAt) return 'Revoked';
  if (link.expiresAt && new Date(link.expiresAt) <= new Date()) return 'Expired';
  if (link.maxUses !== null && link.useCount >= link.maxUses) return 'Used up';
  return 'Active';
}

/**
 * Invitation links and QR codes (owners and admins). A link is shown in full
 * only right after it is created — the server keeps just a hash of it.
 */
export function InviteLinks({
  kind,
  id,
  name,
}: {
  kind: 'group' | 'channel';
  id: string;
  name: string;
}) {
  const target = useMemo<LinkTarget>(
    () => (kind === 'group' ? { groupId: id } : { channelId: id }),
    [kind, id],
  );
  const [links, setLinks] = useState<InviteLinkView[]>();
  const [created, setCreated] = useState<CreatedInviteLink>();
  const [hours, setHours] = useState(7 * 24);
  const [maxUses, setMaxUses] = useState('');
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    linksApi.list(target, controller.signal).then(setLinks, () => {
      if (!controller.signal.aborted) setError('Links could not be loaded.');
    });
    return () => {
      controller.abort();
    };
  }, [target, created]);

  const url = created ? buildInviteUrl(window.location.origin, created.token) : undefined;

  return (
    <div className={styles.formStack}>
      <form
        className={styles.inlineForm}
        onSubmit={(event) => {
          event.preventDefault();
          setError(undefined);
          setCopied(false);
          const uses = Number(maxUses);
          linksApi
            .create(target, {
              expiresInHours: hours,
              ...(maxUses && Number.isInteger(uses) && uses > 0 ? { maxUses: uses } : {}),
            })
            .then(setCreated, (cause: unknown) => {
              setError(cause instanceof Error ? cause.message : 'The link could not be created.');
            });
        }}
      >
        <label>
          <span className={styles.visuallyHidden}>Expires after</span>
          <select
            className={styles.select}
            value={hours}
            onChange={(event) => {
              setHours(Number(event.target.value));
            }}
          >
            {EXPIRY_CHOICES.map((choice) => (
              <option key={choice.hours} value={choice.hours}>
                Expires in {choice.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className={styles.visuallyHidden}>Maximum uses</span>
          <input
            className={styles.select}
            inputMode="numeric"
            placeholder="Unlimited uses"
            value={maxUses}
            onChange={(event) => {
              setMaxUses(event.target.value.replace(/\D/g, ''));
            }}
          />
        </label>
        <button type="submit" className={styles.smallButton}>
          Create link
        </button>
      </form>
      {error ? <Alert>{error}</Alert> : null}
      {created && url ? (
        <div className={styles.createdLink}>
          <Alert tone="info">
            Copy or share this link now — for your safety OGC can’t show it again. Anyone with it
            can ask to join {name} until it expires or you revoke it.
          </Alert>
          <QrCode payload={url} label={`Invitation QR code for ${name}`} />
          <code className={styles.linkText}>{url}</code>
          <div className={styles.confirmActions}>
            <button
              type="button"
              className={styles.smallButton}
              onClick={() => {
                void navigator.clipboard.writeText(url).then(() => {
                  setCopied(true);
                });
              }}
            >
              {copied ? 'Copied' : 'Copy link'}
            </button>
            {typeof navigator.share === 'function' ? (
              <button
                type="button"
                className={styles.smallButton}
                onClick={() => {
                  void navigator
                    .share({ title: `Join ${name} on OGC`, url })
                    .catch(() => undefined);
                }}
              >
                Share
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <ul className={styles.pickList} aria-label="Invitation links">
        {links?.map((link) => {
          const state = linkState(link);
          return (
            <li key={link.id} className={styles.linkRow}>
              <span>
                {state} · used {link.useCount}
                {link.maxUses !== null ? `/${String(link.maxUses)}` : ''}
                {link.expiresAt ? ` · until ${new Date(link.expiresAt).toLocaleDateString()}` : ''}
              </span>
              {state === 'Active' ? (
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => {
                    linksApi.revoke(link.id).then(
                      () => {
                        setLinks((current) =>
                          current?.map((l) =>
                            l.id === link.id ? { ...l, revokedAt: new Date().toISOString() } : l,
                          ),
                        );
                      },
                      () => {
                        setError('The link could not be revoked.');
                      },
                    );
                  }}
                >
                  Revoke
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
