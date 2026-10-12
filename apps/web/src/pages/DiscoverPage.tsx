import type { PublicProfile } from '@ogc/types';
import { ogcIdInputSchema } from '@ogc/validation';
import { type SyntheticEvent, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { PublicProfileCard } from '../components/PublicProfileCard';
import styles from '../components/social.module.css';
import { Alert, Button, TextField } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { errorMessage } from '../lib/form';

/** Find someone by their exact OGC ID — the primary, privacy-preserving discovery method. */
export function DiscoverPage() {
  const [input, setInput] = useState('');
  const [inputError, setInputError] = useState<string>();
  const [result, setResult] = useState<PublicProfile | 'not-found'>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function lookup(ogcId: string) {
    setBusy(true);
    setError(undefined);
    try {
      setResult(await api.discover(ogcId));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setResult('not-found');
      else {
        setResult(undefined);
        setError(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: SyntheticEvent) {
    event.preventDefault();
    const parsed = ogcIdInputSchema.safeParse(input);
    if (!parsed.success) {
      setInputError(parsed.error.issues[0]?.message);
      return;
    }
    setInputError(undefined);
    void lookup(parsed.data);
  }

  return (
    <AppShell title="Discover">
      <form className={styles.card} onSubmit={onSubmit} noValidate role="search">
        <TextField
          label="OGC ID"
          placeholder="OGC 482 731 905"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
          }}
          error={inputError}
          hint="Ask the person for their OGC ID, or scan their OGC QR code."
          autoComplete="off"
          spellCheck={false}
          inputMode="text"
        />
        <div className={styles.actions}>
          <Button type="submit" busy={busy}>
            Find
          </Button>
        </div>
      </form>

      {error ? <Alert>{error}</Alert> : null}
      {result === 'not-found' ? (
        <div className={styles.empty} role="status">
          No OGC account was found for that ID. Check the ID with the person you are looking for.
        </div>
      ) : null}
      {result && result !== 'not-found' ? (
        <PublicProfileCard profile={result} onChanged={() => void lookup(result.ogcId)} />
      ) : null}
    </AppShell>
  );
}
