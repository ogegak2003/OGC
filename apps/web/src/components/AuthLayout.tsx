import type { ReactNode } from 'react';
import { Link } from 'react-router';
import styles from './AuthLayout.module.css';
import { Icon, type IconName } from './Icon';
import { OgcMark } from './OgcMark';

const POINTS: { icon: IconName; text: string }[] = [
  { icon: 'qr', text: 'Share an OGC ID or QR code — never your phone number' },
  { icon: 'lock', text: 'Direct messages and groups are end-to-end encrypted' },
  { icon: 'community', text: 'Groups for your circle, channels for larger audiences' },
];

/** Two-panel layout for the signed-out journey: brand statement beside the task. */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className={styles.layout}>
      <aside className={styles.brand}>
        <Link to="/" className={styles.logo} aria-label="OGC home">
          <OgcMark size={36} />
          <span>OGC</span>
        </Link>
        <div className={styles.statement}>
          <p className={styles.eyebrow}>ObagaGlobal Communication</p>
          <p className={styles.headline}>One identity. Everyone, everywhere.</p>
          <p className={styles.sample} aria-hidden="true">
            OGC ··· ··· ···
          </p>
          <ul className={styles.points}>
            {POINTS.map((point) => (
              <li key={point.text}>
                <Icon name={point.icon} size={18} />
                {point.text}
              </li>
            ))}
          </ul>
        </div>
        <p className={styles.legal}>© ObagaGlobal Ltd</p>
      </aside>
      <main className={styles.main}>
        <div className={styles.panel}>
          <h1 className={styles.title}>{title}</h1>
          {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
          {children}
          {footer ? <div className={styles.footer}>{footer}</div> : null}
        </div>
      </main>
    </div>
  );
}
