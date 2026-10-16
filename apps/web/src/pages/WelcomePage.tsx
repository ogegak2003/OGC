import { Link } from 'react-router';
import { Icon, type IconName } from '../components/Icon';
import { OgcLogo } from '../components/OgcLogo';
import styles from './WelcomePage.module.css';

/** What OGC does today — each line describes a shipped capability, nothing aspirational. */
const FEATURES: { icon: IconName; title: string; text: string }[] = [
  {
    icon: 'lock',
    title: 'End-to-end encrypted messages',
    text: 'Direct and group chats are encrypted on your devices with MLS.',
  },
  {
    icon: 'user',
    title: 'One OGC ID',
    text: 'People find you by your OGC ID or QR code — your email stays private.',
  },
  {
    icon: 'video',
    title: 'Voice and video calls',
    text: 'Call your contacts from any conversation, on the web or your phone.',
  },
  {
    icon: 'megaphone',
    title: 'Groups and channels',
    text: 'Private groups for your people, public channels for your community.',
  },
];

/**
 * The first screen signed-out visitors see: the OGC brand, a plain statement of what OGC is,
 * the way into the existing registration and sign-in flows, and what you get.
 */
export function WelcomePage() {
  return (
    <main className={styles.page}>
      <div className={styles.layout}>
        <header className={styles.brand}>
          <OgcLogo height={36} />
        </header>

        <section className={styles.content} aria-labelledby="welcome-title">
          <p className={styles.eyebrow}>ObagaGlobal Communication</p>
          <h1 id="welcome-title" className={styles.title}>
            Private conversations,
            <br />
            one OGC ID.
          </h1>
          <p className={styles.lead}>
            Message, call and organise with the people who matter — encrypted on your devices,
            reachable by an ID you control.
          </p>
          <div className={styles.actions}>
            <Link to="/register" className={styles.primary}>
              Create Account
              <Icon name="arrowRight" size={20} className={styles.arrow} />
            </Link>
            <Link to="/login" className={styles.secondary}>
              Sign In
            </Link>
          </div>
        </section>

        <ul className={styles.features} aria-label="What OGC offers">
          {FEATURES.map((feature) => (
            <li key={feature.title} className={styles.feature}>
              <span className={styles.featureIcon}>
                <Icon name={feature.icon} size={20} />
              </span>
              <span className={styles.featureTitle}>{feature.title}</span>
              <span className={styles.featureText}>{feature.text}</span>
            </li>
          ))}
        </ul>

        <footer className={styles.footer}>
          OGC never shows your email address to other people.
        </footer>
      </div>
    </main>
  );
}
