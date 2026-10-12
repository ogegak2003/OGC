import type { ReportCategory } from '@ogc/types';
import {
  REPORT_DESCRIPTION_MAX_LENGTH,
  formatOgcIdForDisplay,
  normalizeOgcId,
  reportUserRequestSchema,
} from '@ogc/validation';
import { type SyntheticEvent, useId, useState } from 'react';
import { Link, useParams } from 'react-router';
import { AppShell } from '../components/AppShell';
import styles from '../components/social.module.css';
import { Alert, Button } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage } from '../lib/form';

const CATEGORIES: { value: ReportCategory; label: string }[] = [
  { value: 'SPAM', label: 'Spam or unwanted contact' },
  { value: 'HARASSMENT', label: 'Harassment or bullying' },
  { value: 'IMPERSONATION', label: 'Pretending to be someone else' },
  { value: 'INAPPROPRIATE_CONTENT', label: 'Inappropriate profile content' },
  { value: 'SCAM_OR_FRAUD', label: 'Scam or fraud' },
  { value: 'OTHER', label: 'Something else' },
];

/** Report a user to OGC moderators. Reports are confidential: the person is not told. */
export function ReportPage() {
  const { ogcId: raw = '' } = useParams();
  const ogcId = normalizeOgcId(raw);
  const categoryId = useId();
  const descriptionId = useId();
  const [category, setCategory] = useState<ReportCategory | ''>('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    const parsed = reportUserRequestSchema.safeParse({ ogcId, category, description });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the form and try again.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api.reportUser({
        ogcId: parsed.data.ogcId,
        category: parsed.data.category,
        description,
      });
      setSent(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (!ogcId) {
    return (
      <AppShell title="Report">
        <Alert>This report link is not valid.</Alert>
      </AppShell>
    );
  }

  return (
    <AppShell title="Report">
      {sent ? (
        <div className={styles.card} role="status">
          <Alert tone="success">Thank you. Our moderators will review your report.</Alert>
          <p className={styles.muted}>
            If you feel unsafe, you can also block this person so they can no longer find or contact
            you.
          </p>
          <Link className={styles.textLink} to={`/id/${ogcId}`}>
            Back to the profile
          </Link>
        </div>
      ) : (
        <form className={styles.card} onSubmit={(e) => void submit(e)} noValidate>
          <p className={styles.muted}>
            Reporting <span className={styles.ogcId}>{formatOgcIdForDisplay(ogcId)}</span>. Reports
            are confidential — the person is not told who reported them.
          </p>
          {error ? <Alert>{error}</Alert> : null}
          <label htmlFor={categoryId} className={styles.legend}>
            What is the problem?
          </label>
          <select
            id={categoryId}
            className={styles.select}
            value={category}
            onChange={(e) => {
              setCategory(e.target.value as ReportCategory | '');
            }}
            required
          >
            <option value="" disabled>
              Choose a reason
            </option>
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <label htmlFor={descriptionId} className={styles.legend}>
            Details (optional)
          </label>
          <textarea
            id={descriptionId}
            className={styles.textarea}
            value={description}
            maxLength={REPORT_DESCRIPTION_MAX_LENGTH}
            onChange={(e) => {
              setDescription(e.target.value);
            }}
          />
          <div className={styles.actions}>
            <Button type="submit" busy={busy}>
              Send report
            </Button>
            <Link className={styles.textLink} to={`/id/${ogcId}`}>
              Cancel
            </Link>
          </div>
        </form>
      )}
    </AppShell>
  );
}
