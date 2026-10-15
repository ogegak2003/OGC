import { Link, useLocation } from 'react-router';
import { AuthLayout } from '../components/AuthLayout';
import styles from './forms.module.css';
import { Icon } from '../components/Icon';

export function CheckEmailPage() {
  const { state } = useLocation() as { state: { email?: string } | null };
  const email = state?.email;

  return (
    <AuthLayout
      title="Check your email"
      footer={
        <>
          Verified already? <Link to="/login">Sign in</Link>
        </>
      }
    >
      <div className={styles.stack}>
        <div className={styles.icon} aria-hidden="true">
          <Icon name="mail" size={28} />
        </div>
        <p className={styles.muted}>
          If {email ? <span className={styles.strong}>{email}</span> : 'that address'} can be used
          for a new account, we have sent a verification link to it. Open the link to activate your
          account and your OGC ID.
        </p>
        <p className={styles.muted}>
          The link expires in 24 hours. If nothing arrives, check your spam folder, or sign in to
          request a new one.
        </p>
      </div>
    </AuthLayout>
  );
}
