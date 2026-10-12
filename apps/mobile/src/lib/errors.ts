import type { ApiErrorCode } from '@ogc/types';
import type { z } from 'zod';
import { ApiError } from '../api/client';

export function fieldErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'form');
    errors[key] ??= issue.message;
  }
  return errors;
}

const MESSAGES: Partial<Record<ApiErrorCode, string>> = {
  INVALID_CREDENTIALS: 'That email and password combination is not correct.',
  ACCOUNT_UNAVAILABLE: 'This account is not available. Contact support for help.',
  RATE_LIMITED: 'Too many attempts. Please wait a moment and try again.',
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return (error.code && MESSAGES[error.code]) ?? error.message;
  return 'We could not reach OGC. Check your connection and try again.';
}
