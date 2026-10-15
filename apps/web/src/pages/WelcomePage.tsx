import { LOGO_TAGLINE } from '@ogc/ui';
import { Link } from 'react-router';
import globe from '../assets/welcome-globe.webp';
import { Icon } from '../components/Icon';
import { OgcLogo } from '../components/OgcLogo';
import styles from './WelcomePage.module.css';

/**
 * The first screen signed-out visitors see: the OGC brand over the Earth at dawn, and the
 * way into the existing registration and sign-in flows.
 */
export function WelcomePage() {
  return (
    <main className={styles.page}>
      <div className={styles.layout}>
        <header className={styles.brand}>
          <OgcLogo height={44} className={styles.logo} />
          <p className={styles.tagline}>{LOGO_TAGLINE}</p>
        </header>

        {/* Decorative. The gradient behind the image stands in if it cannot load. */}
        <div className={styles.globe} aria-hidden="true">
          <img
            src={globe}
            alt=""
            width={1400}
            height={1400}
            decoding="async"
            fetchPriority="high"
            onError={(event) => {
              event.currentTarget.hidden = true;
            }}
          />
        </div>

        <section className={styles.content} aria-labelledby="welcome-title">
          <p className={styles.eyebrow}>Welcome to</p>
          <h1 id="welcome-title" className={styles.title}>
            OGC Global
            <br />
            Communication
          </h1>
          <p className={styles.lead}>
            Connect with people, communities and opportunities — anywhere in the world.
          </p>
          <div className={styles.actions}>
            <Link to="/register" className={styles.primary}>
              Create Account
              <Icon name="arrowRight" size={20} className={styles.arrow} />
            </Link>
            <Link to="/login" className={styles.secondary}>
              Sign In
              <Icon name="arrowRight" size={20} className={styles.arrow} />
            </Link>
          </div>
        </section>

        <footer className={styles.footer}>One ID. A world of possibilities.</footer>
      </div>
    </main>
  );
}
