import type { OgcId, ProfileSummary } from '@ogc/types';
import { formatOgcIdForDisplay } from '@ogc/validation';
import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Avatar } from './Avatar';
import { Icon, type IconName } from './Icon';
import styles from './kit.module.css';
import { Modal } from './messaging/Modal';
import { Button } from './ui';
import ui from './ui.module.css';
import { tabId, tabPanelId } from './kit-ids';

/** A link that looks like a button (navigation, not an action). */
export function LinkButton({
  to,
  icon,
  variant = 'secondary',
  children,
}: {
  to: string;
  icon?: IconName;
  variant?: 'primary' | 'secondary' | 'ghost';
  children: ReactNode;
}) {
  return (
    <Link to={to} className={[ui.button, ui[variant], styles.linkButton].join(' ')}>
      {icon ? <Icon name={icon} size={18} /> : null}
      <span>{children}</span>
    </Link>
  );
}

/** One-line page introduction under the shell's page title. */
export function PageIntro({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className={styles.intro}>
      <p className={styles.introText}>{children}</p>
      {actions ? <div className={styles.introActions}>{actions}</div> : null}
    </div>
  );
}

/** A friendly empty state: what is missing and, where useful, the one action that fixes it. */
export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={styles.empty}>
      <span className={styles.emptyIcon}>
        <Icon name={icon} size={22} />
      </span>
      <p className={styles.emptyTitle}>{title}</p>
      {children ? <p className={styles.emptyText}>{children}</p> : null}
      {action}
    </div>
  );
}

export interface SegmentOption<T extends string> {
  id: T;
  label: string;
  count?: number | undefined;
  /** What the count means, read by screen readers ("3 pending"). */
  countLabel?: string;
}

/**
 * Tabs with optional counts: arrow keys move between them (WAI-ARIA tabs pattern). Panels use
 * `id={tabPanelId(prefix, id)}` and `aria-labelledby={tabId(prefix, id)}`.
 */
export function SegmentedTabs<T extends string>({
  label,
  prefix,
  options,
  value,
  onChange,
}: {
  label: string;
  prefix: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = (index + delta + options.length) % options.length;
    const option = options[next];
    if (!option) return;
    onChange(option.id);
    refs.current[next]?.focus();
  };
  return (
    <div className={styles.tabs} role="tablist" aria-label={label}>
      {options.map((option, index) => {
        const selected = option.id === value;
        return (
          <button
            key={option.id}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={tabId(prefix, option.id)}
            aria-selected={selected}
            aria-controls={tabPanelId(prefix, option.id)}
            tabIndex={selected ? 0 : -1}
            className={styles.tab}
            onClick={() => {
              onChange(option.id);
            }}
            onKeyDown={(event) => {
              onKeyDown(event, index);
            }}
          >
            {option.label}
            {option.count ? (
              <span
                className={styles.tabCount}
                aria-label={`${String(option.count)} ${option.countLabel ?? 'pending'}`}
              >
                {option.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** A labelled search box with a clear button. */
export function FilterField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className={styles.search}>
      <label htmlFor={id} className={styles.visuallyHidden}>
        {label}
      </label>
      <Icon name="search" size={18} className={styles.searchIcon} />
      <input
        id={id}
        type="search"
        className={styles.searchInput}
        value={value}
        placeholder={placeholder ?? label}
        autoComplete="off"
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      {value ? (
        <button
          type="button"
          className={styles.searchClear}
          aria-label="Clear"
          onClick={() => {
            onChange('');
          }}
        >
          <Icon name="close" size={16} />
        </button>
      ) : null}
    </div>
  );
}

/** A person in a list: avatar (with presence when known), name, OGC ID, and actions. */
export function PersonRow({
  profile,
  online,
  meta,
  children,
}: {
  profile: ProfileSummary;
  /** Only pass when presence is actually known for this person. */
  online?: boolean | undefined;
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className={styles.person}>
      <Link to={`/id/${profile.ogcId}`} className={styles.personLink}>
        <span className={styles.personAvatar}>
          <Avatar url={profile.avatarUrl} name={profile.displayName} size={44} />
          {online === undefined ? null : (
            <span
              className={online ? styles.presenceOn : styles.presenceOff}
              role="img"
              aria-label={online ? 'Online' : 'Offline'}
            />
          )}
        </span>
        <span className={styles.personText}>
          <span className={styles.personName}>{profile.displayName}</span>
          <span className={styles.personId}>{formatOgcIdForDisplay(profile.ogcId)}</span>
          {meta ? <span className={styles.personMeta}>{meta}</span> : null}
        </span>
      </Link>
      {children ? <div className={styles.personActions}>{children}</div> : null}
    </li>
  );
}

/** A list of `PersonRow`s. */
export function PeopleList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul className={styles.people} aria-label={label}>
      {children}
    </ul>
  );
}

/** The OGC ID set large in monospace, with a copy button that confirms what it copied. */
export function OgcIdBadge({ ogcId, size = 'md' }: { ogcId: OgcId; size?: 'md' | 'lg' }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className={[styles.idBadge, size === 'lg' ? styles.idBadgeLg : ''].join(' ')}>
      <span className={styles.idText} aria-label={ogcId}>
        {formatOgcIdForDisplay(ogcId)}
      </span>
      <button
        type="button"
        className={styles.idCopy}
        aria-label={copied ? 'OGC ID copied' : 'Copy OGC ID'}
        title={copied ? 'Copied' : 'Copy OGC ID'}
        onClick={() => {
          void navigator.clipboard.writeText(ogcId).then(() => {
            setCopied(true);
            window.setTimeout(() => {
              setCopied(false);
            }, 2000);
          });
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} size={16} />
      </button>
    </span>
  );
}

/** A titled group of settings or details, rendered as one card. */
export function Section({
  title,
  description,
  children,
  tone = 'default',
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  tone?: 'default' | 'danger';
}) {
  const id = useId();
  return (
    <section
      className={[styles.section, tone === 'danger' ? styles.sectionDanger : ''].join(' ')}
      aria-labelledby={id}
    >
      <header className={styles.sectionHeader}>
        <h2 id={id} className={styles.sectionTitle}>
          {title}
        </h2>
        {description ? <p className={styles.sectionDescription}>{description}</p> : null}
      </header>
      <div className={styles.sectionBody}>{children}</div>
    </section>
  );
}

/** A row inside a Section: an icon, a label with detail, and a control or link. */
export function SettingRow({
  icon,
  title,
  detail,
  to,
  children,
}: {
  icon?: IconName;
  title: string;
  detail?: ReactNode;
  /** Makes the whole row a link. */
  to?: string;
  children?: ReactNode;
}) {
  const inner = (
    <>
      {icon ? (
        <span className={styles.rowIcon}>
          <Icon name={icon} size={18} />
        </span>
      ) : null}
      <span className={styles.rowText}>
        <span className={styles.rowTitle}>{title}</span>
        {detail ? <span className={styles.rowDetail}>{detail}</span> : null}
      </span>
      {children}
      {to ? <Icon name="chevronRight" size={18} className={styles.rowChevron} /> : null}
    </>
  );
  return to ? (
    <Link to={to} className={[styles.row, styles.rowLink].join(' ')}>
      {inner}
    </Link>
  ) : (
    <div className={styles.row}>{inner}</div>
  );
}

/**
 * Confirmation for sensitive actions: says what will happen, and the confirm button names the
 * action (never just "OK"). Errors from the action are shown in the dialog.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  tone = 'danger',
  busy = false,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  tone?: 'danger' | 'primary';
  busy?: boolean;
  error?: string | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <div className={styles.confirm}>
        <div className={styles.confirmBody}>{children}</div>
        {error ? (
          <p className={styles.confirmError} role="alert">
            {error}
          </p>
        ) : null}
        <div className={styles.confirmActions}>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            busy={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
