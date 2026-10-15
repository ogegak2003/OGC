import type { Route, Tab } from '../navigation';

/** Where a tapped push should take the person. */
export type PushDestination = { route: Route } | { tab: Tab };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVITATION_TYPES = new Set(['GROUP_INVITATION']);

/**
 * The screen for a tapped push (PushData from @ogc/types). Push data is treated as untrusted
 * input: anything malformed opens nothing. The screen then loads the content through the
 * normal authenticated, end-to-end encrypted flow — the push itself carries no content.
 */
export function routeForPush(data: unknown): PushDestination | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const push = data as Record<string, unknown>;
  switch (push.type) {
    case 'message':
    case 'call': {
      // A call opens its conversation; a call that is still ringing shows over it (call.sync).
      const conversationId = push.conversationId;
      if (typeof conversationId !== 'string' || !UUID.test(conversationId)) return undefined;
      return { route: { name: 'conversation', conversationId } };
    }
    case 'community':
      return typeof push.notification === 'string' && INVITATION_TYPES.has(push.notification)
        ? { route: { name: 'invitations' } }
        : { route: { name: 'notifications' } };
    case 'contact':
      return { tab: 'contacts' };
    default:
      return undefined;
  }
}
