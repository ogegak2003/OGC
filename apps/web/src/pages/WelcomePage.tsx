import { Link } from 'react-router';
import { OgcMark } from '../components/OgcMark';
import styles from './WelcomePage.module.css';

export function WelcomePage() {
  return (
    <main className={styles.page}>
      <div className={styles.glow} aria-hidden="true" />
      <header className={styles.header}>
        <span className={styles.logo}>
          <OgcMark size={32} />
          OGC
        </span>
        <Link to="/login" className={styles.signIn}>
          Sign in
        </Link>
      </header>

      <section className={styles.hero} aria-labelledby="welcome-title">
        <p className={styles.eyebrow}>ObagaGlobal Communication</p>
        <h1 id="welcome-title" className={styles.title}>
          Your identity.
          <br />
          <span className={styles.accent}>Not your phone number.</span>
        </h1>
        <p className={styles.lead}>
          Every OGC account gets a permanent OGC ID — a private, shareable identity that lets people
          reach you without ever seeing your number.
        </p>
        <div className={styles.actions}>
          <Link to="/register" className={styles.primary}>
            Create your OGC ID
          </Link>
          <Link to="/login" className={styles.secondary}>
            I already have one
          </Link>
        </div>
      </section>

      <div className={styles.card} aria-hidden="true">
        <span className={styles.cardLabel}>OGC ID</span>
        <span className={styles.cardId}>OGC 482 731 905</span>
        <span className={styles.cardNote}>Random. Permanent. Yours.</span>
      </div>
    </main>
  );
}
