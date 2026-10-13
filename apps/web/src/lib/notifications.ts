import type { NotificationView } from '@ogc/types';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Plain-language line and destination for a notification (data holds IDs and names only). */
export function describeNotification(n: NotificationView): { line: string; to?: string } {
  const d = n.data;
  const group = text(d.groupName) || 'a group';
  const channel = text(d.channelName) || 'a channel';
  const conversation = text(d.conversationId);
  const channelId = text(d.channelId);
  switch (n.type) {
    case 'GROUP_INVITATION':
      return { line: `You’re invited to ${group}`, to: '/invitations' };
    case 'GROUP_MEMBER_ADDED':
      return {
        line: 'Someone accepted your invitation',
        ...(conversation ? { to: `/messages/${conversation}` } : {}),
      };
    case 'GROUP_MEMBER_REMOVED':
      return { line: `You were removed from ${group}` };
    case 'GROUP_ROLE_CHANGED':
      return {
        line: `Your role in ${group} changed`,
        ...(conversation ? { to: `/messages/${conversation}` } : {}),
      };
    case 'GROUP_DETAILS_CHANGED':
      return {
        line: `${group} was updated`,
        ...(conversation ? { to: `/messages/${conversation}` } : {}),
      };
    case 'MENTION':
      return conversation
        ? { line: `You were mentioned in ${group}`, to: `/messages/${conversation}` }
        : { line: `You were mentioned in ${channel}`, to: `/channels/${channelId}` };
    case 'CHANNEL_ANNOUNCEMENT':
      return { line: `New announcement in ${channel}`, to: `/channels/${channelId}` };
    case 'CHANNEL_ROLE_CHANGED':
      return { line: `Your role in ${channel} changed`, to: `/channels/${channelId}` };
    case 'CHANNEL_JOIN_REQUEST':
      return { line: `Someone asked to join ${channel}`, to: `/channels/${channelId}` };
    case 'CHANNEL_REQUEST_APPROVED':
      return { line: `You can now post in ${channel}`, to: `/channels/${channelId}` };
    case 'CHANNEL_MEMBER_REMOVED':
      return { line: `A moderator changed your access to ${channel}` };
    case 'MODERATION_RESULT':
      return { line: `Moderators reviewed your report in ${channel}` };
    case 'INVITATION_EXPIRED':
      return { line: `An invitation you sent to ${group} expired` };
  }
}
