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
