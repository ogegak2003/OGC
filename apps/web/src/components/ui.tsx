import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  useId,
  useState,
} from 'react';
import styles from './ui.module.css';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost';
  busy?: boolean;
};

export function Button({
  variant = 'primary',
  busy = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={[styles.button, styles[variant], className].filter(Boolean).join(' ')}
      disabled={disabled === true || busy}
      aria-busy={busy || undefined}
    >
      {busy ? <span className={styles.buttonSpinner} aria-hidden="true" /> : null}
      <span>{children}</span>
    </button>
  );
}

type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> & {
  label: string;
  error?: string | undefined;
  hint?: ReactNode;
  trailing?: ReactNode;
};

export function TextField({ label, error, hint, trailing, className, ...input }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : undefined, error ? errorId : undefined]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={[styles.field, className].filter(Boolean).join(' ')}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      <div className={styles.inputWrap} data-invalid={error ? true : undefined}>
        <input
          id={id}
          className={styles.input}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          {...input}
        />
        {trailing}
      </div>
      {error ? (
        <p id={errorId} className={styles.error}>
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function PasswordField(props: Omit<FieldProps, 'type' | 'trailing'>) {
  const [visible, setVisible] = useState(false);
  return (
    <TextField
      {...props}
      type={visible ? 'text' : 'password'}
      trailing={
        <button
          type="button"
          className={styles.reveal}
          onClick={() => {
            setVisible((v) => !v);
          }}
          aria-pressed={visible}
          aria-label={visible ? 'Hide password' : 'Show password'}
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      }
    />
  );
}

export function Alert({
  tone = 'error',
  children,
}: {
  tone?: 'error' | 'info' | 'success';
  children: ReactNode;
}) {
  return (
    <div
      className={[styles.alert, styles[`alert-${tone}`]].join(' ')}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      {children}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className={styles.spinnerWrap} role="status" aria-live="polite">
      <span className={styles.spinner} aria-hidden="true" />
      <span className={styles.visuallyHidden}>{label}</span>
    </div>
  );
}
