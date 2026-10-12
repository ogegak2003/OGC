import { useState } from 'react';
import styles from './social.module.css';

/** Profile photo with an initials fallback (also used when the photo cannot load). */
export function Avatar({
  url,
  name,
  size = 48,
}: {
  url: string | null;
  name: string;
  size?: number;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || '·';
  const dimension = { width: size, height: size, fontSize: size * 0.38 };

  if (url && failed !== url) {
    return (
      <img
        className={styles.avatar}
        src={url}
        alt=""
        width={size}
        height={size}
        onError={() => {
          setFailed(url);
        }}
      />
    );
  }
  return (
    <span className={styles.avatarFallback} style={dimension} aria-hidden="true">
      {initials}
    </span>
  );
}
