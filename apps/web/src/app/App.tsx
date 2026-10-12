import { formatOgcId } from '@ogc/validation';
import { useEffect, useState } from 'react';
import { fetchHealth } from '../lib/api';
import styles from './App.module.css';

type ApiState = 'checking' | 'online' | 'offline';

const STATUS_LABEL: Record<ApiState, string> = {
  checking: 'Checking API…',
  online: 'API online',
  offline: 'API unreachable',
};

/** Phase 0 shell: brand foundation plus a live API connectivity check. */
export function App() {
  const [apiState, setApiState] = useState<ApiState>('checking');

  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(controller.signal)
      .then(() => {
        setApiState('online');
      })
      .catch(() => {
        if (!controller.signal.aborted) setApiState('offline');
      });
    return () => {
      controller.abort();
    };
  }, []);

  return (
    <main className={styles.shell}>
      <section className={styles.card} aria-labelledby="ogc-title">
        <div className={styles.mark} aria-hidden="true" />
        <h1 id="ogc-title" className={styles.title}>
          OGC
        </h1>
        <p className={styles.subtitle}>ObagaGlobal Communication</p>
        <p className={styles.identity} aria-label="Example OGC identity">
          {formatOgcId(1)}
        </p>
        <p className={styles.status} data-state={apiState} role="status">
          <span className={styles.dot} aria-hidden="true" />
          {STATUS_LABEL[apiState]}
        </p>
      </section>
      <footer className={styles.footer}>Platform foundation · Phase 0</footer>
    </main>
  );
}
