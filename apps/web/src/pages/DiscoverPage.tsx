import type { PublicProfile } from '@ogc/types';
import { ogcIdInputSchema } from '@ogc/validation';
import { type SyntheticEvent, useState } from 'react';
import { useSearchParams } from 'react-router';
import { AppShell } from '../components/AppShell';
import { EmptyState, PageIntro, Section } from '../components/kit';
import { PublicProfileCard } from '../components/PublicProfileCard';
import { Alert, Button, TextField } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { errorMessage } from '../lib/form';
import styles from './DiscoverPage.module.css';

/** Find someone by their exact OGC ID — the primary, privacy-preserving discovery method. */
export function DiscoverPage() {
  // `?q=` comes from the global search: the OGC ID field starts with it.
  const [params] = useSearchParams();
  const [input, setInput] = useState(params.get('q') ?? '');
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
    <AppShell title="Find by OGC ID">
      <div className={styles.page}>
        <PageIntro>
          OGC has no public directory. To add someone, ask for their OGC ID or scan their OGC QR
          code — spaces and capitals do not matter.
        </PageIntro>
        <Section title="Look up an OGC ID">
          <form className={styles.form} onSubmit={onSubmit} noValidate role="search">
            <TextField
              label="OGC ID"
              placeholder="OGC 482 731 905"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
              }}
              error={inputError}
              hint="The person can find theirs on their Home screen."
              autoComplete="off"
              spellCheck={false}
              inputMode="text"
              className={styles.field}
            />
            <Button type="submit" icon="search" busy={busy}>
              Find
            </Button>
          </form>
        </Section>

        {error ? <Alert>{error}</Alert> : null}
        {result === 'not-found' ? (
          <div role="status">
            <EmptyState icon="search" title="No account found">
              No OGC account was found for that ID. Check the ID with the person you are looking
              for. People who chose not to be findable only appear to their contacts.
            </EmptyState>
          </div>
        ) : null}
        {result && result !== 'not-found' ? (
          <PublicProfileCard profile={result} onChanged={() => void lookup(result.ogcId)} />
        ) : null}
      </div>
    </AppShell>
  );
}
