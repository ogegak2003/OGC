import { conversationTitle } from '@ogc/messaging';
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMessaging } from '../messaging/messaging-context';
import styles from './GlobalSearch.module.css';
import { Icon, type IconName } from './Icon';

interface Option {
  key: string;
  icon: IconName;
  label: string;
  hint: string;
  to: string;
}

const CONVERSATION_MATCHES = 5;

/**
 * Search across what OGC can actually search: your conversations (by name, on this device),
 * people by their exact OGC ID (Discover), and the public channel directory. A combobox:
 * arrow keys move, Enter opens, Escape closes.
 */
export function GlobalSearch({
  autoFocus = false,
  onDone,
}: {
  autoFocus?: boolean;
  /** Called after a result is opened (e.g. to close the phone search row). */
  onDone?: () => void;
}) {
  const navigate = useNavigate();
  const { conversations } = useMessaging();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const text = query.trim();

  const options = useMemo<Option[]>(() => {
    if (!text) return [];
    const needle = text.toLowerCase();
    const matches = conversations
      .filter((c) => conversationTitle(c).toLowerCase().includes(needle))
      .slice(0, CONVERSATION_MATCHES)
      .map<Option>((c) => ({
        key: `c-${c.id}`,
        icon: c.group ? (c.group.kind === 'CHANNEL' ? 'hash' : 'community') : 'chat',
        label: conversationTitle(c),
        hint: c.group ? (c.group.kind === 'CHANNEL' ? 'Private channel' : 'Group') : 'Chat',
        to: `/messages/${c.id}`,
      }));
    const people: Option = {
      key: 'people',
      icon: 'userPlus',
      label: `Find “${text}” by OGC ID`,
      hint: 'People',
      to: `/discover?q=${encodeURIComponent(text)}`,
    };
    const channels: Option = {
      key: 'channels',
      icon: 'megaphone',
      label: `Search public channels for “${text}”`,
      hint: 'Channels',
      to: `/channels?q=${encodeURIComponent(text)}`,
    };
    // Something that looks like an OGC ID puts the people lookup first.
    return /\d{3}/.test(text) ? [people, ...matches, channels] : [...matches, people, channels];
  }, [text, conversations]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const choose = (option: Option | undefined) => {
    if (!option) return;
    setOpen(false);
    setQuery('');
    void navigate(option.to);
    onDone?.();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, options.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(options[active] ?? options[0]);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  const expanded = open && options.length > 0;
  return (
    <div className={styles.search} ref={wrap}>
      <Icon name="search" size={18} className={styles.icon} />
      <input
        type="search"
        role="combobox"
        className={styles.input}
        placeholder="Search chats, people or channels…"
        aria-label="Search chats, people or channels"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={expanded ? `${listId}-${String(active)}` : undefined}
        value={query}
        autoFocus={autoFocus}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => {
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      <ul id={listId} role="listbox" className={styles.list} hidden={!expanded}>
        {options.map((option, index) => (
          <li
            key={option.key}
            id={`${listId}-${String(index)}`}
            role="option"
            aria-selected={index === active}
            className={index === active ? styles.optionActive : styles.option}
            onPointerDown={(event) => {
              event.preventDefault();
              choose(option);
            }}
            onPointerEnter={() => {
              setActive(index);
            }}
          >
            <Icon name={option.icon} size={18} />
            <span className={styles.optionLabel}>{option.label}</span>
            <span className={styles.optionHint}>{option.hint}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
