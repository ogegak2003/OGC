import type { ChannelView } from '@ogc/types';
import {
  CHANNEL_DESCRIPTION_MAX_LENGTH,
  COMMUNITY_NAME_MAX_LENGTH,
  channelHandleSchema,
} from '@ogc/validation';
import { useState } from 'react';
import { channelsApi } from '../../lib/community-api';
import { Modal } from '../messaging/Modal';
import styles from '../messaging/messaging.module.css';
import { Alert } from '../ui';

/** Creates a community channel. Community channels are server-readable, and say so. */
export function CreateChannelDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (channel: ChannelView) => void;
}) {
  const [handle, setHandle] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'PUBLIC' | 'PRIVATE'>('PUBLIC');
  const [joinPolicy, setJoinPolicy] = useState<'OPEN' | 'APPROVAL'>('OPEN');
  const [postPolicy, setPostPolicy] = useState<'ADMINS' | 'MODERATORS' | 'ALL_MEMBERS'>('ADMINS');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  return (
    <Modal title="New community channel" onClose={onClose}>
      <form
        className={styles.formStack}
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = channelHandleSchema.safeParse(handle);
          if (!parsed.success) {
            setError('Handles use 5–32 letters, digits or underscores and start with a letter.');
            return;
          }
          setBusy(true);
          setError(undefined);
          channelsApi
            .create({
              handle: parsed.data,
              name: name.trim(),
              ...(description.trim() ? { description: description.trim() } : {}),
              visibility,
              joinPolicy,
              postPolicy,
              repliesEnabled: true,
            })
            .then(onCreated, (cause: unknown) => {
              setBusy(false);
              setError(
                cause instanceof Error ? cause.message : 'The channel could not be created.',
              );
            });
        }}
      >
        <Alert tone="info">
          Community channels are not end-to-end encrypted. OGC can read posts so it can offer
          search, discovery and moderation. For private conversations, create an encrypted group
          instead.
        </Alert>
        <label className={styles.formStack}>
          <span>Name</span>
          <input
            className={styles.search}
            value={name}
            maxLength={COMMUNITY_NAME_MAX_LENGTH}
            required
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </label>
        <label className={styles.formStack}>
          <span>Handle</span>
          <input
            className={styles.search}
            value={handle}
            placeholder="night_sky"
            autoCapitalize="none"
            spellCheck={false}
            required
            onChange={(event) => {
              setHandle(event.target.value);
            }}
          />
        </label>
        <label className={styles.formStack}>
          <span>Description (optional)</span>
          <textarea
            className={styles.textarea}
            value={description}
            maxLength={CHANNEL_DESCRIPTION_MAX_LENGTH}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        </label>
        <label className={styles.formStack}>
          <span>Who can find it</span>
          <select
            className={styles.select}
            value={visibility}
            onChange={(event) => {
              setVisibility(event.target.value as 'PUBLIC' | 'PRIVATE');
            }}
          >
            <option value="PUBLIC">Public — anyone on OGC can find and read it</option>
            <option value="PRIVATE">Private — members only, join by invitation link</option>
          </select>
        </label>
        <label className={styles.formStack}>
          <span>Joining</span>
          <select
            className={styles.select}
            value={joinPolicy}
            onChange={(event) => {
              setJoinPolicy(event.target.value as 'OPEN' | 'APPROVAL');
            }}
          >
            <option value="OPEN">Anyone who can see it can join</option>
            <option value="APPROVAL">Moderators approve new members</option>
          </select>
        </label>
        <label className={styles.formStack}>
          <span>Who can write posts</span>
          <select
            className={styles.select}
            value={postPolicy}
            onChange={(event) => {
              setPostPolicy(event.target.value as 'ADMINS' | 'MODERATORS' | 'ALL_MEMBERS');
            }}
          >
            <option value="ADMINS">Admins (members reply and react)</option>
            <option value="MODERATORS">Moderators and admins</option>
            <option value="ALL_MEMBERS">All members</option>
          </select>
        </label>
        {error ? <Alert>{error}</Alert> : null}
        <button type="submit" className={styles.newButton} disabled={busy}>
          {busy ? 'Creating…' : 'Create channel'}
        </button>
      </form>
    </Modal>
  );
}
