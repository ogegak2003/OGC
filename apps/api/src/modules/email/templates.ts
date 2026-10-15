import type { EmailMessage } from './email-sender.js';

const SIGNATURE = '— OGC, ObagaGlobal Communication';

/**
 * The token travels in the URL fragment, which browsers never send to servers
 * or in Referer headers, so it cannot leak into access logs.
 */
export function verificationEmail(to: string, webAppUrl: string, token: string): EmailMessage {
  const link = `${webAppUrl}/verify-email#token=${token}`;
  return {
    kind: 'verify-email',
    to,
    subject: 'Verify your OGC account',
    text: [
      'Welcome to OGC.',
      '',
      'Confirm your email address to activate your account:',
      link,
      '',
      'This link expires in 24 hours and can be used once.',
      'If you did not create an OGC account, you can ignore this email.',
      '',
      SIGNATURE,
    ].join('\n'),
  };
}

/** Sent instead of a second account when someone registers with an address already in use. */
export function accountExistsEmail(to: string, webAppUrl: string): EmailMessage {
  return {
    kind: 'account-exists',
    to,
    subject: 'Someone tried to create an OGC account with your email',
    text: [
      'An attempt was made to create a new OGC account using this email address,',
      'which already has an account.',
      '',
      `If this was you, sign in instead: ${webAppUrl}/login`,
      'If it was not you, no action is needed — your account has not changed.',
      '',
      SIGNATURE,
    ].join('\n'),
  };
}

/**
 * A password-reset link. The token travels in the URL fragment (never sent to servers or in
 * Referer headers). The email says plainly what a reset does and does not recover.
 */
export function passwordResetEmail(
  to: string,
  webAppUrl: string,
  token: string,
  validMinutes: number,
): EmailMessage {
  return {
    kind: 'password-reset',
    to,
    subject: 'Reset your OGC password',
    text: [
      'Someone asked to reset the password of the OGC account for this email address.',
      '',
      'To choose a new password, open this link:',
      `${webAppUrl}/reset-password#token=${token}`,
      '',
      `The link expires in ${String(validMinutes)} minutes and can be used once.`,
      'Resetting signs you out on every device. Your end-to-end encrypted messages stay on',
      'the devices that already have them; a device that signs out loses its copy, and a',
      'password reset cannot bring encrypted messages back.',
      '',
      'If you did not ask for this, ignore this email — your password has not changed.',
      '',
      SIGNATURE,
    ].join('\n'),
  };
}

/** Confirms a password change or reset, so an owner who did not do it can react. */
export function passwordChangedEmail(
  to: string,
  webAppUrl: string,
  how: 'changed' | 'reset',
): EmailMessage {
  return {
    kind: 'password-changed',
    to,
    subject: 'Your OGC password was changed',
    text: [
      how === 'reset'
        ? 'The password of your OGC account was reset with an emailed link, and every device was signed out.'
        : 'The password of your OGC account was changed, and your other devices were signed out.',
      '',
      'If this was you, no action is needed.',
      `If it was not, reset your password now: ${webAppUrl}/forgot-password`,
      '',
      SIGNATURE,
    ].join('\n'),
  };
}
