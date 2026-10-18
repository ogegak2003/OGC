import {
  BRIDGE_FINAL_STATUSES,
  type BridgeCallStatus,
  type BridgeCallView,
  type BridgeEligibilityView,
  type BridgeIneligibleReason,
  type BridgeStatusView,
  type BridgeUsageView,
  type BridgeVerificationView,
  type ContactView,
} from '@ogc/types';
import { BRIDGE_CODE_LENGTH, formatOgcIdForDisplay } from '@ogc/validation';
import { type SyntheticEvent, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { AppShell } from '../components/AppShell';
import { ConfirmDialog, EmptyState, PageIntro, Section, SettingRow } from '../components/kit';
import { Alert, Button, Spinner, TextField } from '../components/ui';
import { api } from '../lib/api';
import { bridgeApi } from '../lib/bridge-api';
import { errorMessage } from '../lib/form';
import styles from './BridgePage.module.css';

/** How often an active call is refreshed. States come only from the server (provider-backed). */
const POLL_MS = 2000;

const REASONS: Record<BridgeIneligibleReason, string> = {
  BRIDGE_DISABLED: 'OGC Bridge is turned off on this server.',
  NOT_CONFIGURED: 'No telephone provider is set up on this server yet, so no calls can be placed.',
  NOT_A_CONTACT: 'You can only call your contacts through OGC Bridge.',
  CALLER_NUMBER_REQUIRED:
    'Link and verify your own phone number first: OGC Bridge rings it to connect you.',
  UNAVAILABLE: 'This person cannot be reached through OGC Bridge.',
  COUNTRY_NOT_SUPPORTED: 'Calls to this country are not available yet.',
  LIMIT_REACHED: 'You have reached your OGC Bridge limit for now. Try again later.',
};

const STATUS_TEXT: Record<BridgeCallStatus, string> = {
  REQUESTED: 'Connecting',
  RINGING: 'Ringing',
  ANSWERED: 'Connected',
  COMPLETED: 'Completed',
  BUSY: 'Busy',
  NO_ANSWER: 'No answer',
  REJECTED: 'Declined',
  FAILED: 'Did not connect',
  CANCELED: 'Canceled',
};

const isFinal = (status: BridgeCallStatus) => BRIDGE_FINAL_STATUSES.includes(status);

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${String(m)} min ${String(s)} s` : `${String(s)} s`;
}

/** Minor units to a display amount, using the currency's own number of decimals. */
function formatMoney(amountMinor: number, currency: string): string {
  try {
    const format = new Intl.NumberFormat(undefined, { style: 'currency', currency });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(amountMinor / 10 ** digits);
  } catch {
    return `${String(amountMinor)} ${currency} (minor units)`;
  }
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** The current time, re-rendering every second until `until` (epoch ms), for countdowns. */
function useNow(until: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= until) window.clearInterval(timer);
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [until]);
  return now;
}

/**
 * `/calls/bridge`: OGC Bridge, the optional way to call a contact's telephone. Shows only what
 * the server reports: when no provider is configured it says so, and simulated calls are labelled.
 */
export function BridgePage() {
  const [status, setStatus] = useState<BridgeStatusView>();
  const [loadError, setLoadError] = useState<string>();

  const load = useCallback((signal?: AbortSignal) => {
    bridgeApi.status(signal).then(
      (next) => {
        setStatus(next);
        setLoadError(undefined);
      },
      (error: unknown) => {
        if (!signal?.aborted) setLoadError(errorMessage(error));
      },
    );
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load]);

  return (
    <AppShell title="OGC Bridge">
      <PageIntro>
        Call a contact&apos;s ordinary telephone. Optional: OGC-to-OGC calls work as before without
        it. <Link to="/calls">Back to calls</Link>
      </PageIntro>
      {loadError ? (
        <div className={styles.page}>
          <Alert>{loadError}</Alert>
          <div>
            <Button
              variant="secondary"
              icon="refresh"
              onClick={() => {
                setLoadError(undefined);
                load();
              }}
            >
              Try again
            </Button>
          </div>
        </div>
      ) : !status ? (
        <Spinner label="Loading OGC Bridge" />
      ) : (
        <BridgeContent status={status} reload={load} />
      )}
    </AppShell>
  );
}

function BridgeContent({ status, reload }: { status: BridgeStatusView; reload: () => void }) {
  if (!status.enabled) {
    return (
      <div className={styles.page}>
        <EmptyState icon="phoneOff" title="OGC Bridge is not available">
          Calling telephone numbers is turned off on this server. Your OGC voice and video calls are
          not affected.
        </EmptyState>
        {status.number ? <NumberSection status={status} reload={reload} /> : null}
      </div>
    );
  }
  const configured = status.provider !== 'disabled';
  return (
    <div className={styles.page}>
      {!configured ? (
        <Alert tone="info">
          OGC Bridge is switched on, but no telephone provider is set up yet. You cannot link a
          number or place calls until the server operator connects one.
        </Alert>
      ) : status.provider === 'simulated' ? (
        <Alert tone="info">
          <strong>Simulation.</strong> This server uses the development simulator: no text message
          is sent, no telephone rings and nothing is charged. Call progress below is simulated.
        </Alert>
      ) : null}

      <Section title="Before you use it" description="How OGC Bridge differs from OGC calls.">
        <SettingRow
          icon="alert"
          title="Not end-to-end encrypted"
          detail="Telephone calls travel over the public telephone network. OGC and the telephone provider can process them; unlike OGC-to-OGC calls, they are not end-to-end encrypted."
        />
        <SettingRow
          icon="phone"
          title="Your phone rings first"
          detail="OGC Bridge calls your own verified phone, then connects you to your contact's phone. Calls go to contacts who have linked a number and allowed it."
        />
        <SettingRow
          icon="eye"
          title="Numbers stay private"
          detail="Nobody sees your number in OGC. Your contacts see only that they can call you."
        />
      </Section>

      <NumberSection status={status} reload={reload} />
      {configured ? <CallSection status={status} /> : null}
    </div>
  );
}

function NumberSection({ status, reload }: { status: BridgeStatusView; reload: () => void }) {
  const number = status.number;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  if (number) {
    const toggle = (value: boolean) => {
      setBusy(true);
      setError(undefined);
      bridgeApi
        .setAllowContactCalls(value)
        .then(reload, (e: unknown) => {
          setError(errorMessage(e));
        })
        .finally(() => {
          setBusy(false);
        });
    };
    return (
      <Section title="Your number" description="Only you can see it, and only in this masked form.">
        <SettingRow
          icon="shieldCheck"
          title="Verified number"
          detail={
            <>
              <span className={styles.number}>{number.maskedNumber}</span>
              {number.verifiedAt ? ` · verified ${formatTime(number.verifiedAt)}` : null}
            </>
          }
        />
        <label className={styles.consent}>
          <input
            type="checkbox"
            role="switch"
            className={styles.switch}
            checked={number.allowContactCalls}
            disabled={busy || !status.enabled}
            onChange={(event) => {
              toggle(event.target.checked);
            }}
          />
          <span>
            <strong>Let my contacts call this number through OGC Bridge.</strong> They never see the
            number. Turn off at any time.
          </span>
        </label>
        {error ? <Alert>{error}</Alert> : null}
        <div className={styles.actions}>
          <Button
            variant="danger"
            icon="trash"
            onClick={() => {
              setError(undefined);
              setConfirmUnlink(true);
            }}
          >
            Unlink number
          </Button>
        </div>
        {confirmUnlink ? (
          <ConfirmDialog
            title="Unlink your phone number?"
            confirmLabel="Unlink number"
            busy={busy}
            error={error}
            onCancel={() => {
              setConfirmUnlink(false);
            }}
            onConfirm={() => {
              setBusy(true);
              setError(undefined);
              bridgeApi
                .unlink()
                .then(
                  () => {
                    setConfirmUnlink(false);
                    reload();
                  },
                  (e: unknown) => {
                    setError(errorMessage(e));
                  },
                )
                .finally(() => {
                  setBusy(false);
                });
            }}
          >
            <p>
              You will no longer be able to place OGC Bridge calls, and your contacts will no longer
              be able to call this number. To use OGC Bridge again you will need to verify a number
              again.
            </p>
          </ConfirmDialog>
        ) : null}
      </Section>
    );
  }

  if (!status.enabled) return null;
  if (status.provider === 'disabled') {
    return (
      <Section title="Your number">
        <p className={styles.muted}>
          Linking a number becomes available once a provider is set up.
        </p>
      </Section>
    );
  }
  return status.verification ? (
    <ConfirmCode verification={status.verification} status={status} reload={reload} />
  ) : (
    <LinkNumber status={status} reload={reload} />
  );
}

function LinkNumber({ status, reload }: { status: BridgeStatusView; reload: () => void }) {
  const [country, setCountry] = useState(status.countries[0]?.code ?? '');
  const [number, setNumber] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const selected = status.countries.find((c) => c.code === country);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (!consent) {
      setError('Please confirm that this is your number and that you agree to verification.');
      return;
    }
    setBusy(true);
    setError(undefined);
    bridgeApi
      .startVerification({ country, number: number.trim(), consent: true })
      .then(reload, (e: unknown) => {
        setError(errorMessage(e));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Section
      title="Link your phone number"
      description={
        status.provider === 'simulated'
          ? 'We will create a verification code. In this simulation it is written to the development outbox instead of being sent by SMS.'
          : 'We will send a verification code to this number by SMS.'
      }
    >
      {status.countries.length === 0 ? (
        <p className={styles.muted}>No countries are enabled on this server yet.</p>
      ) : (
        <form className={styles.form} onSubmit={submit} noValidate>
          <div className={styles.fieldRow}>
            <label className={styles.label}>
              Country
              <select
                className={styles.select}
                value={country}
                onChange={(event) => {
                  setCountry(event.target.value);
                }}
              >
                {status.countries.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name} (+{c.callingCode})
                  </option>
                ))}
              </select>
            </label>
            <TextField
              label="Mobile number"
              type="tel"
              inputMode="tel"
              autoComplete="tel-national"
              required
              value={number}
              hint={selected ? `A ${selected.name} mobile number that you own.` : undefined}
              onChange={(event) => {
                setNumber(event.target.value);
              }}
            />
          </div>
          <label className={styles.consent}>
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => {
                setConsent(event.target.checked);
              }}
            />
            <span>
              This is my number. I agree that OGC stores it to place calls I start, and sends a
              verification code to it. It is never shown to anyone else.
            </span>
          </label>
          {error ? <Alert>{error}</Alert> : null}
          <div className={styles.actions}>
            <Button type="submit" busy={busy} disabled={number.trim() === ''}>
              Send code
            </Button>
          </div>
        </form>
      )}
    </Section>
  );
}

function ConfirmCode({
  verification,
  status,
  reload,
}: {
  verification: BridgeVerificationView;
  status: BridgeStatusView;
  reload: () => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [again, setAgain] = useState(false);
  const resendAt = new Date(verification.resendAvailableAt).getTime();
  const now = useNow(resendAt);
  const wait = Math.max(0, Math.ceil((resendAt - now) / 1000));

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    bridgeApi
      .confirm({ verificationId: verification.id, code })
      .then(reload, (e: unknown) => {
        setError(errorMessage(e));
        setCode('');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Section
      title="Enter your code"
      description={
        verification.delivery === 'simulated'
          ? 'Simulation: no SMS was sent. The code is in the development outbox on the server.'
          : 'We sent a code by SMS. It expires at ' +
            new Date(verification.expiresAt).toLocaleTimeString(undefined, {
              timeStyle: 'short',
            }) +
            '.'
      }
    >
      <form className={styles.form} onSubmit={submit} noValidate>
        <TextField
          label="Verification code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={BRIDGE_CODE_LENGTH}
          pattern="\d*"
          value={code}
          hint={`${String(verification.attemptsRemaining)} attempts left.`}
          onChange={(event) => {
            setCode(event.target.value.replace(/\D/g, ''));
          }}
        />
        {error ? <Alert>{error}</Alert> : null}
        <div className={styles.actions}>
          <Button type="submit" busy={busy} disabled={code.length !== BRIDGE_CODE_LENGTH}>
            Verify number
          </Button>
        </div>
      </form>
      <p className={styles.muted} aria-live="polite">
        {wait > 0
          ? `You can ask for a new code in ${String(wait)} s.`
          : 'Did not get it? You can ask for a new code.'}
      </p>
      {wait === 0 && !again ? (
        <div className={styles.actions}>
          <Button
            variant="secondary"
            onClick={() => {
              setAgain(true);
            }}
          >
            Get a new code
          </Button>
        </div>
      ) : null}
      {again ? <LinkNumber status={{ ...status, verification: null }} reload={reload} /> : null}
    </Section>
  );
}

function CallSection({ status }: { status: BridgeStatusView }) {
  const [contacts, setContacts] = useState<ContactView[]>();
  const [selected, setSelected] = useState('');
  // Keyed by contact, so a stale answer for a previous choice is never shown.
  const [checked, setChecked] = useState<{ ogcId: string; view: BridgeEligibilityView }>();
  const eligibility = checked?.ogcId === selected ? checked.view : undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [active, setActive] = useState<BridgeCallView>();
  const [history, setHistory] = useState<BridgeCallView[]>();
  const [usage, setUsage] = useState<BridgeUsageView>();

  const refreshHistory = useCallback(() => {
    bridgeApi.calls().then(setHistory, () => {
      setHistory([]);
    });
    bridgeApi.usage().then(setUsage, () => {
      setUsage(undefined);
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api.contacts(undefined, controller.signal).then(
      (page) => {
        setContacts(page.items);
      },
      () => {
        if (!controller.signal.aborted) setContacts([]);
      },
    );
    refreshHistory();
    return () => {
      controller.abort();
    };
  }, [refreshHistory]);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    bridgeApi.eligibility(selected, controller.signal).then(
      (view) => {
        setChecked({ ogcId: selected, view });
      },
      (e: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      },
    );
    return () => {
      controller.abort();
    };
  }, [selected, status.number]);

  // Follow the active call until the server reports a final state.
  useEffect(() => {
    if (!active || isFinal(active.status)) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      bridgeApi.call(active.id, controller.signal).then(
        (next) => {
          setActive(next);
          if (isFinal(next.status)) refreshHistory();
        },
        () => {
          // Keep the last known state; the next poll retries.
          if (!controller.signal.aborted) setActive({ ...active });
        },
      );
    }, POLL_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [active, refreshHistory]);

  const call = () => {
    setBusy(true);
    setError(undefined);
    bridgeApi
      .startCall(selected, crypto.randomUUID())
      .then(
        (started) => {
          setActive(started);
          if (isFinal(started.status)) refreshHistory();
        },
        (e: unknown) => {
          setError(errorMessage(e));
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };

  const end = (id: string) => {
    setError(undefined);
    bridgeApi.endCall(id).then(
      (next) => {
        setActive(next);
        if (isFinal(next.status)) refreshHistory();
      },
      (e: unknown) => {
        setError(errorMessage(e));
      },
    );
  };

  const live = active && !isFinal(active.status);

  return (
    <>
      <Section
        title="Call a contact"
        description="Choose a contact to see whether you can reach them."
      >
        {contacts === undefined ? (
          <Spinner label="Loading your contacts" />
        ) : contacts.length === 0 ? (
          <EmptyState icon="contacts" title="No contacts yet">
            OGC Bridge calls go to your contacts. <Link to="/contacts">Add a contact</Link> first.
          </EmptyState>
        ) : (
          <div className={styles.form}>
            <label className={styles.label}>
              Contact
              <select
                className={styles.select}
                value={selected}
                disabled={Boolean(live)}
                onChange={(event) => {
                  setError(undefined);
                  setSelected(event.target.value);
                }}
              >
                <option value="">Choose a contact</option>
                {contacts.map((c) => (
                  <option key={c.profile.ogcId} value={c.profile.ogcId}>
                    {c.profile.displayName} ({formatOgcIdForDisplay(c.profile.ogcId)})
                  </option>
                ))}
              </select>
            </label>
            {selected && !eligibility && !error ? (
              <p className={styles.muted} role="status">
                Checking…
              </p>
            ) : null}
            {eligibility && !eligibility.eligible && eligibility.reason ? (
              <Alert tone="info">{REASONS[eligibility.reason]}</Alert>
            ) : null}
            {error ? <Alert>{error}</Alert> : null}
            <div className={styles.actions}>
              <Button
                icon="phone"
                busy={busy}
                disabled={!eligibility?.eligible || Boolean(live)}
                onClick={call}
              >
                {status.provider === 'simulated' ? 'Start simulated call' : 'Call phone'}
              </Button>
            </div>
          </div>
        )}
      </Section>

      {active ? (
        <section className={styles.active} aria-labelledby="bridge-active" aria-live="polite">
          <h2 id="bridge-active" className={styles.activeTitle}>
            {active.callee.displayName}: {STATUS_TEXT[active.status]}
            {active.simulated ? ' (simulated)' : ''}
          </h2>
          {live ? (
            <p className={styles.muted}>
              {active.status === 'REQUESTED'
                ? 'Your phone will ring first. Answer it to be connected.'
                : 'Keep talking on your phone. You can end the call here or by hanging up.'}
            </p>
          ) : (
            <p className={styles.muted}>
              {active.failureReason ??
                (active.durationSeconds !== null
                  ? `Duration ${formatDuration(active.durationSeconds)}.`
                  : 'The call has ended.')}
            </p>
          )}
          <div className={styles.actions}>
            {live ? (
              <Button
                variant="danger"
                icon="phoneOff"
                onClick={() => {
                  end(active.id);
                }}
              >
                End call
              </Button>
            ) : (
              <Button
                variant="secondary"
                onClick={() => {
                  setActive(undefined);
                }}
              >
                Dismiss
              </Button>
            )}
          </div>
        </section>
      ) : null}

      <Section
        title="Bridge call history"
        description="Outcomes as reported by the telephone provider."
      >
        {history === undefined ? (
          <Spinner label="Loading call history" />
        ) : history.length === 0 ? (
          <p className={styles.muted}>No OGC Bridge calls yet.</p>
        ) : (
          <ul className={styles.history}>
            {history.map((c) => (
              <li key={c.id} className={styles.historyRow}>
                <span className={styles.historyMain}>
                  <span className={styles.name}>{c.callee.displayName}</span>
                  <span className={styles.muted}>
                    {STATUS_TEXT[c.status]}
                    {c.durationSeconds !== null ? ` · ${formatDuration(c.durationSeconds)}` : ''}
                    {c.failureReason ? ` · ${c.failureReason}` : ''}
                  </span>
                </span>
                <span className={styles.muted}>
                  {c.simulated ? <span className={styles.badge}>Simulated</span> : null}{' '}
                  {c.charge
                    ? `${formatMoney(c.charge.amountMinor, c.charge.currency)}${c.charge.state === 'estimate' ? ' (estimate)' : ''} · `
                    : ''}
                  {formatTime(c.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Usage and limits"
        description="Charges appear only when the provider reports them and a tariff is set; simulated calls are never charged."
      >
        <dl className={styles.stats}>
          <div className={styles.stat}>
            <dt>Calls today</dt>
            <dd>
              {usage ? String(usage.callsToday) : '–'} of {String(status.limits.callsPerDay)}
            </dd>
          </div>
          <div className={styles.stat}>
            <dt>Longest call</dt>
            <dd>{formatDuration(status.limits.maxCallSeconds)}</dd>
          </div>
          <div className={styles.stat}>
            <dt>At the same time</dt>
            <dd>{String(status.limits.concurrentCalls)}</dd>
          </div>
        </dl>
        {usage && usage.entries.length > 0 ? (
          <ul className={styles.history} aria-label="Charges">
            {usage.entries.map((entry) => (
              <li key={entry.id} className={styles.historyRow}>
                <span>
                  {entry.kind === 'CHARGE'
                    ? 'Call charge'
                    : entry.kind === 'REFUND'
                      ? 'Refund'
                      : 'Adjustment'}
                  {entry.state === 'estimate' ? ' (estimate)' : ''}
                </span>
                <span className={styles.muted}>
                  {formatMoney(entry.amountMinor, entry.currency)} · {formatTime(entry.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.muted}>No charges recorded.</p>
        )}
      </Section>
    </>
  );
}
