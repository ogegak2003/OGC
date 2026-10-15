import type { ProfileSummary } from '@ogc/types';
import { useCallUnavailable } from '../../messaging/hooks';
import { useMessaging } from '../../messaging/messaging-context';
import { Icon } from '../Icon';
import styles from './calls.module.css';

/**
 * Voice and video call buttons for a direct conversation. Disabled, with the reason as the
 * tooltip, when a call cannot start (offline, already in a call, no WebRTC).
 */
export function CallButtons({
  conversationId,
  peer,
  name,
}: {
  conversationId: string;
  peer: ProfileSummary;
  /** Who is called, for the accessible labels. */
  name: string;
}) {
  const { calls } = useMessaging();
  const unavailable = useCallUnavailable();
  return (
    <span className={styles.headerActions}>
      {(['AUDIO', 'VIDEO'] as const).map((media) => {
        const label = `${media === 'VIDEO' ? 'Video' : 'Voice'} call ${name}`;
        return (
          <button
            key={media}
            type="button"
            className={styles.headerCall}
            aria-label={label}
            title={unavailable ?? label}
            disabled={unavailable !== undefined}
            onClick={() => {
              void calls?.start(conversationId, media, peer);
            }}
          >
            <Icon name={media === 'VIDEO' ? 'video' : 'phone'} size={20} />
          </button>
        );
      })}
    </span>
  );
}
