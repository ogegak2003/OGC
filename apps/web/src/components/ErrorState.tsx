import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Icon, type IconName } from './Icon';
import { LinkButton } from './kit';
import styles from './ErrorState.module.css';
import ui from './ui.module.css';

export type ErrorKind = 'not-found' | 'forbidden' | 'unavailable';

const KIND: Record<ErrorKind, { code: string; icon: IconName }> = {
  'not-found': { code: '404', icon: 'compass' },
  forbidden: { code: '403', icon: 'shield' },
  unavailable: { code: '410', icon: 'clock' },
};

/**
 * A branded, accessible error state: what happened, in plain words, and where to go next.
 * Never says more than the server did — "not found" and "not available to you" stay
 * indistinguishable where the API keeps them so (it does not reveal what exists).
 */
export function ErrorState({
  kind,
  title,
  children,
  home = { to: '/home', label: 'Go to Home', icon: 'home' },
  heading = 'h2',
}: {
  kind: ErrorKind;
  title: string;
  children?: ReactNode;
  /** The main way out. */
  home?: { to: string; label: string; icon?: IconName };
  /** Heading level for `title`; `none` when the surrounding layout already shows it as h1. */
  heading?: 'h1' | 'h2' | 'none';
}) {
  const navigate = useNavigate();
  // "default" is the first entry of this tab's history: there is nowhere in OGC to go back to.
  const canGoBack = useLocation().key !== 'default';
  const { code, icon } = KIND[kind];
  const Heading = heading === 'none' ? null : heading;
  return (
    <section
      className={[styles.state, Heading ? '' : styles.plain].join(' ')}
      aria-labelledby={Heading ? 'error-title' : undefined}
    >
      <span className={styles.badge} aria-hidden="true">
        <Icon name={icon} size={28} />
      </span>
      <p className={styles.code} aria-hidden="true">
        {code}
      </p>
      {Heading ? (
        <Heading id="error-title" className={styles.title}>
          {title}
        </Heading>
      ) : null}
      {children ? <div className={styles.text}>{children}</div> : null}
      <div className={styles.actions}>
        <LinkButton to={home.to} icon={home.icon ?? 'home'} variant="primary">
          {home.label}
        </LinkButton>
        {canGoBack ? (
          <button
            type="button"
            className={[ui.button, ui.secondary].join(' ')}
            onClick={() => {
              void navigate(-1);
            }}
          >
            <Icon name="back" size={18} />
            Go back
          </button>
        ) : null}
      </div>
    </section>
  );
}
