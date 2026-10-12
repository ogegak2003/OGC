import type { OwnProfile } from '@ogc/types';
import { BIO_MAX_LENGTH, updateProfileRequestSchema } from '@ogc/validation';
import { type ChangeEvent, type SyntheticEvent, useCallback, useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { AppShell } from '../components/AppShell';
import { Avatar } from '../components/Avatar';
import styles from '../components/social.module.css';
import { Alert, Button, Spinner, TextField } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage, fieldErrors } from '../lib/form';
import { useResource } from '../lib/use-resource';
import forms from './forms.module.css';

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 5 * 1024 * 1024;

function ProfileForm({
  initial,
  onSaved,
}: {
  initial: OwnProfile;
  onSaved: (p: OwnProfile) => void;
}) {
  const navigate = useNavigate();
  const bioId = useId();
  const [profile, setProfile] = useState(initial);
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [bio, setBio] = useState(initial.bio ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string }>();
  const [busy, setBusy] = useState<'save' | 'photo' | 'remove'>();

  async function save(event: SyntheticEvent) {
    event.preventDefault();
    const parsed = updateProfileRequestSchema.safeParse({ displayName, bio });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setBusy('save');
    try {
      onSaved(await api.updateProfile({ displayName, bio }));
      void navigate('/home');
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) });
    } finally {
      setBusy(undefined);
    }
  }

  async function choosePhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    // Quick feedback only; the server re-validates the actual image content.
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setNotice({ tone: 'error', text: 'Choose a JPEG, PNG or WebP image.' });
      return;
    }
    if (file.size > MAX_BYTES) {
      setNotice({ tone: 'error', text: 'Choose an image of 5 MB or less.' });
      return;
    }
    setBusy('photo');
    try {
      const updated = await api.uploadAvatar(file);
      setProfile(updated);
      onSaved(updated);
      setNotice({ tone: 'success', text: 'Profile photo updated.' });
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) });
    } finally {
      setBusy(undefined);
    }
  }

  async function removePhoto() {
    setBusy('remove');
    try {
      const updated = await api.removeAvatar();
      setProfile(updated);
      onSaved(updated);
      setNotice({ tone: 'success', text: 'Profile photo removed.' });
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) });
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <form className={styles.card} onSubmit={(e) => void save(e)} noValidate>
      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
      <div className={styles.identityRow}>
        <Avatar url={profile.avatarUrl} name={displayName || profile.displayName} size={88} />
        <div className={styles.actions}>
          <label className={forms.linkButton}>
            {busy === 'photo' ? 'Uploading…' : 'Choose photo'}
            <input
              type="file"
              accept={ACCEPTED_TYPES.join(',')}
              hidden
              onChange={(e) => void choosePhoto(e)}
              disabled={busy !== undefined}
            />
          </label>
          {profile.avatarUrl ? (
            <Button variant="secondary" busy={busy === 'remove'} onClick={() => void removePhoto()}>
              Remove photo
            </Button>
          ) : null}
        </div>
      </div>
      <p className={styles.muted}>
        JPEG, PNG or WebP up to 5 MB. Photos are cropped to a square and stripped of location data.
      </p>
      <TextField
        label="Display name"
        value={displayName}
        onChange={(e) => {
          setDisplayName(e.target.value);
        }}
        error={errors.displayName}
        hint="Display names are not unique — your OGC ID is what identifies you."
        autoComplete="name"
      />
      <div className={forms.stack}>
        <label htmlFor={bioId} className={styles.legend}>
          About
        </label>
        <textarea
          id={bioId}
          className={styles.textarea}
          value={bio}
          maxLength={BIO_MAX_LENGTH * 2}
          onChange={(e) => {
            setBio(e.target.value);
          }}
          aria-describedby={`${bioId}-count`}
          aria-invalid={errors.bio ? true : undefined}
        />
        <p id={`${bioId}-count`} className={styles.muted}>
          {errors.bio ?? `${bio.trim().length} / ${BIO_MAX_LENGTH}`}
        </p>
      </div>
      <div className={styles.actions}>
        <Button type="submit" busy={busy === 'save'}>
          Save profile
        </Button>
        <Button variant="ghost" onClick={() => void navigate('/home')}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function EditProfilePage() {
  const load = useCallback((signal: AbortSignal) => api.profile(signal), []);
  const { state, set } = useResource(load);
  return (
    <AppShell title="Edit profile">
      {state.status === 'loading' ? <Spinner label="Loading your profile" /> : null}
      {state.status === 'error' ? <Alert>{errorMessage(state.error)}</Alert> : null}
      {state.status === 'ready' ? <ProfileForm initial={state.data} onSaved={set} /> : null}
    </AppShell>
  );
}
