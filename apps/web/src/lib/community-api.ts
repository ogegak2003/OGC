import type {
  ChannelAttachmentView,
  ChannelMemberView,
  ChannelPostPage,
  ChannelPostReportView,
  ChannelPostView,
  ChannelView,
  ConversationView,
  CreatedInviteLink,
  GroupMemberView,
  InviteLinkView,
  InvitePreview,
  InviteResult,
  JoinResult,
  ModerationActionView,
  NotificationPage,
  NotificationPreferences,
  Page,
  ReactionType,
  ReceivedInvitationView,
  SentInvitationView,
  VisibilityChangeResult,
} from '@ogc/types';
import type {
  ChannelPostRequest,
  ConversationReportRequest,
  CreateChannelRequest,
  CreateGroupRequest,
  CreateInviteLinkRequest,
  UpdateChannelRequest,
  UpdateGroupRequest,
} from '@ogc/validation';
import { send } from './api';

const enc = encodeURIComponent;

export type LinkTarget = { groupId: string } | { channelId: string };

const linksPath = (target: LinkTarget): string =>
  'groupId' in target
    ? `/v1/groups/${enc(target.groupId)}/invite-links`
    : `/v1/channels/${enc(target.channelId)}/invite-links`;

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** Groups, encrypted channels, invitations and invitation links. */
export const groupsApi = {
  create: (body: CreateGroupRequest) =>
    send<{ conversation: ConversationView; invited: string[] }>('/v1/groups', {
      method: 'POST',
      body,
    }),
  update: (id: string, body: UpdateGroupRequest) =>
    send<ConversationView>(`/v1/groups/${enc(id)}`, { method: 'PATCH', body }),
  members: (id: string, signal?: AbortSignal) =>
    send<GroupMemberView[]>(`/v1/groups/${enc(id)}/members`, { signal }),
  uploadAvatar: (id: string, file: Blob) => {
    const form = new FormData();
    form.append('avatar', file);
    return send<undefined>(`/v1/groups/${enc(id)}/avatar`, { method: 'POST', body: form });
  },
  removeAvatar: (id: string) =>
    send<undefined>(`/v1/groups/${enc(id)}/avatar`, { method: 'DELETE' }),
  setRole: (id: string, ogcId: string, role: 'ADMIN' | 'MEMBER') =>
    send<undefined>(`/v1/groups/${enc(id)}/members/${enc(ogcId)}/role`, {
      method: 'PUT',
      body: { role },
    }),
  removeMember: (id: string, ogcId: string) =>
    send<undefined>(`/v1/groups/${enc(id)}/members/${enc(ogcId)}`, { method: 'DELETE' }),
  leave: (id: string) => send<undefined>(`/v1/groups/${enc(id)}/leave`, { method: 'POST' }),
  transfer: (id: string, ogcId: string) =>
    send<undefined>(`/v1/groups/${enc(id)}/transfer`, { method: 'POST', body: { ogcId } }),
  setArchived: (id: string, archived: boolean) =>
    send<undefined>(`/v1/groups/${enc(id)}/${archived ? 'archive' : 'unarchive'}`, {
      method: 'POST',
    }),
  delete: (id: string) => send<undefined>(`/v1/groups/${enc(id)}`, { method: 'DELETE' }),
  invite: (id: string, ogcIds: string[]) =>
    send<InviteResult>(`/v1/groups/${enc(id)}/invitations`, {
      method: 'POST',
      body: { ogcIds },
    }),
  sentInvitations: (id: string, signal?: AbortSignal) =>
    send<SentInvitationView[]>(`/v1/groups/${enc(id)}/invitations`, { signal }),
  receivedInvitations: (signal?: AbortSignal) =>
    send<ReceivedInvitationView[]>('/v1/invitations', { signal }),
  acceptInvitation: (id: string) =>
    send<{ conversationId: string }>(`/v1/invitations/${enc(id)}/accept`, { method: 'POST' }),
  declineInvitation: (id: string) =>
    send<undefined>(`/v1/invitations/${enc(id)}/decline`, { method: 'POST' }),
  revokeInvitation: (id: string) =>
    send<undefined>(`/v1/invitations/${enc(id)}`, { method: 'DELETE' }),
  preferences: (id: string, signal?: AbortSignal) =>
    send<NotificationPreferences>(`/v1/conversations/${enc(id)}/notifications`, { signal }),
  setPreferences: (id: string, body: Partial<NotificationPreferences>) =>
    send<NotificationPreferences>(`/v1/conversations/${enc(id)}/notifications`, {
      method: 'PUT',
      body,
    }),
  report: (id: string, body: ConversationReportRequest) =>
    send<{ received: true }>(`/v1/conversations/${enc(id)}/reports`, { method: 'POST', body }),
};

export const linksApi = {
  create: (target: LinkTarget, body: CreateInviteLinkRequest) =>
    send<CreatedInviteLink>(linksPath(target), { method: 'POST', body }),
  list: (target: LinkTarget, signal?: AbortSignal) =>
    send<InviteLinkView[]>(linksPath(target), { signal }),
  revoke: (id: string) => send<undefined>(`/v1/invite-links/${enc(id)}`, { method: 'DELETE' }),
  // Tokens travel in request bodies only, never in URLs.
  preview: (token: string) =>
    send<InvitePreview>('/v1/invite-links/preview', { method: 'POST', body: { token } }),
  join: (token: string) =>
    send<JoinResult>('/v1/invite-links/join', { method: 'POST', body: { token } }),
};

/** Community channels: server-readable, not end-to-end encrypted. */
export const channelsApi = {
  mine: (signal?: AbortSignal) => send<ChannelView[]>('/v1/channels', { signal }),
  discover: (q: string, cursor?: string, signal?: AbortSignal) =>
    send<Page<ChannelView>>(`/v1/channels/discover${query({ q: q.trim(), cursor })}`, { signal }),
  get: (id: string, signal?: AbortSignal) =>
    send<ChannelView>(`/v1/channels/${enc(id)}`, { signal }),
  create: (body: CreateChannelRequest) =>
    send<ChannelView>('/v1/channels', { method: 'POST', body }),
  update: (id: string, body: UpdateChannelRequest) =>
    send<ChannelView>(`/v1/channels/${enc(id)}`, { method: 'PATCH', body }),
  changeVisibility: (id: string, visibility: 'PUBLIC' | 'PRIVATE') =>
    send<VisibilityChangeResult>(`/v1/channels/${enc(id)}/visibility`, {
      method: 'POST',
      body: { visibility, confirm: true },
    }),
  uploadAvatar: (id: string, file: Blob) => {
    const form = new FormData();
    form.append('avatar', file);
    return send<undefined>(`/v1/channels/${enc(id)}/avatar`, { method: 'POST', body: form });
  },
  join: (id: string) => send<JoinResult>(`/v1/channels/${enc(id)}/join`, { method: 'POST' }),
  leave: (id: string) => send<undefined>(`/v1/channels/${enc(id)}/leave`, { method: 'POST' }),
  setArchived: (id: string, archived: boolean) =>
    send<undefined>(`/v1/channels/${enc(id)}/${archived ? 'archive' : 'unarchive'}`, {
      method: 'POST',
    }),
  delete: (id: string) => send<undefined>(`/v1/channels/${enc(id)}`, { method: 'DELETE' }),
  markRead: (id: string, seq: number) =>
    send<undefined>(`/v1/channels/${enc(id)}/read`, { method: 'POST', body: { seq } }),
  setPreferences: (id: string, body: Partial<NotificationPreferences>) =>
    send<NotificationPreferences>(`/v1/channels/${enc(id)}/notifications`, {
      method: 'PUT',
      body,
    }),
  posts: (id: string, params: { before?: number; q?: string }, signal?: AbortSignal) =>
    send<ChannelPostPage>(`/v1/channels/${enc(id)}/posts${query(params)}`, { signal }),
  pinned: (id: string, signal?: AbortSignal) =>
    send<ChannelPostView[]>(`/v1/channels/${enc(id)}/pinned`, { signal }),
  thread: (postId: string, signal?: AbortSignal) =>
    send<{ post: ChannelPostView; replies: ChannelPostPage }>(
      `/v1/channel-posts/${enc(postId)}/thread`,
      { signal },
    ),
  post: (id: string, body: ChannelPostRequest) =>
    send<ChannelPostView>(`/v1/channels/${enc(id)}/posts`, { method: 'POST', body }),
  editPost: (postId: string, body: string) =>
    send<ChannelPostView>(`/v1/channel-posts/${enc(postId)}`, { method: 'PATCH', body: { body } }),
  deletePost: (postId: string) =>
    send<undefined>(`/v1/channel-posts/${enc(postId)}`, { method: 'DELETE' }),
  react: (postId: string, reaction: ReactionType, add: boolean) =>
    send<undefined>(`/v1/channel-posts/${enc(postId)}/reactions/${enc(reaction)}`, {
      method: add ? 'PUT' : 'DELETE',
    }),
  pin: (postId: string, pinned: boolean) =>
    send<undefined>(`/v1/channel-posts/${enc(postId)}/pin`, {
      method: pinned ? 'PUT' : 'DELETE',
    }),
  moderatePost: (postId: string, removed: boolean, reason?: string) =>
    send<undefined>(`/v1/channel-posts/${enc(postId)}/${removed ? 'remove' : 'restore'}`, {
      method: 'POST',
      body: reason ? { reason } : {},
    }),
  reportPost: (postId: string, body: { category: string; description?: string }) =>
    send<{ received: true }>(`/v1/channel-posts/${enc(postId)}/reports`, {
      method: 'POST',
      body,
    }),
  uploadMedia: (
    channelId: string,
    file: Blob,
    fields: { kind: string; name: string; mime: string },
  ) => {
    const form = new FormData();
    form.append('channelId', channelId);
    form.append('kind', fields.kind);
    form.append('name', fields.name);
    form.append('mime', fields.mime);
    form.append('file', file, 'upload.bin');
    return send<ChannelAttachmentView>('/v1/channel-attachments', { method: 'POST', body: form });
  },
  members: (
    id: string,
    params: { status?: 'ACTIVE' | 'PENDING' | 'BANNED'; cursor?: string },
    signal?: AbortSignal,
  ) => send<Page<ChannelMemberView>>(`/v1/channels/${enc(id)}/members${query(params)}`, { signal }),
  setRole: (id: string, ogcId: string, role: 'ADMIN' | 'MODERATOR' | 'MEMBER') =>
    send<undefined>(`/v1/channels/${enc(id)}/members/${enc(ogcId)}/role`, {
      method: 'PUT',
      body: { role },
    }),
  suspend: (id: string, ogcId: string, hours: number, reason?: string) =>
    send<undefined>(`/v1/channels/${enc(id)}/members/${enc(ogcId)}/suspend`, {
      method: 'POST',
      body: { hours, ...(reason ? { reason } : {}) },
    }),
  removeMember: (id: string, ogcId: string, reason?: string) =>
    send<undefined>(`/v1/channels/${enc(id)}/members/${enc(ogcId)}`, {
      method: 'DELETE',
      body: reason ? { reason } : {},
    }),
  ban: (id: string, ogcId: string, reason?: string) =>
    send<undefined>(`/v1/channels/${enc(id)}/bans/${enc(ogcId)}`, {
      method: 'POST',
      body: reason ? { reason } : {},
    }),
  unban: (id: string, ogcId: string) =>
    send<undefined>(`/v1/channels/${enc(id)}/bans/${enc(ogcId)}`, { method: 'DELETE', body: {} }),
  decideRequest: (id: string, ogcId: string, approve: boolean) =>
    send<undefined>(
      `/v1/channels/${enc(id)}/requests/${enc(ogcId)}/${approve ? 'approve' : 'reject'}`,
      { method: 'POST' },
    ),
  reports: (id: string, signal?: AbortSignal) =>
    send<Page<ChannelPostReportView>>(`/v1/channels/${enc(id)}/reports`, { signal }),
  resolveReport: (
    reportId: string,
    body: { outcome: 'RESOLVED' | 'DISMISSED'; resolution?: string; removePost?: boolean },
  ) => send<undefined>(`/v1/channel-reports/${enc(reportId)}/resolve`, { method: 'POST', body }),
  history: (id: string, signal?: AbortSignal) =>
    send<Page<ModerationActionView>>(`/v1/channels/${enc(id)}/moderation`, { signal }),
};

export const notificationsApi = {
  list: (cursor?: string, signal?: AbortSignal) =>
    send<NotificationPage>(`/v1/notifications${query({ cursor })}`, { signal }),
  markRead: (body: { ids: string[] } | { all: true }) =>
    send<undefined>('/v1/notifications/read', { method: 'POST', body }),
};
