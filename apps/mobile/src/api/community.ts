import type {
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
  VisibilityChangeResult,
} from '@ogc/types';
import type {
  ChannelPostRequest,
  ConversationReportRequest,
  CreateChannelRequest,
  CreateGroupRequest,
  CreateInviteLinkRequest,
  UpdateGroupRequest,
} from '@ogc/validation';
import type { ApiClient } from './client';

const enc = encodeURIComponent;

function query(params: Record<string, string | number | undefined>): string {
  const pairs = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${enc(String(value))}`);
  return pairs.length ? `?${pairs.join('&')}` : '';
}

export type LinkTarget = { groupId: string } | { channelId: string };

/**
 * Groups, invitations, links, community channels and notifications for the
 * native app, over the authenticated bearer-token client. Invitation tokens
 * travel only in request bodies.
 */
export function communityApi(client: ApiClient) {
  const get = <T>(path: string) => client.request<T>('GET', path);
  const post = <T>(path: string, body?: unknown) => client.request<T>('POST', path, body);
  const linksPath = (target: LinkTarget) =>
    'groupId' in target
      ? `/v1/groups/${enc(target.groupId)}/invite-links`
      : `/v1/channels/${enc(target.channelId)}/invite-links`;
  return {
    groups: {
      create: (body: CreateGroupRequest) =>
        post<{ conversation: ConversationView; invited: string[] }>('/v1/groups', body),
      update: (id: string, body: UpdateGroupRequest) =>
        client.request<ConversationView>('PATCH', `/v1/groups/${enc(id)}`, body),
      members: (id: string) => get<GroupMemberView[]>(`/v1/groups/${enc(id)}/members`),
      setRole: (id: string, ogcId: string, role: 'ADMIN' | 'MEMBER') =>
        client.request<undefined>('PUT', `/v1/groups/${enc(id)}/members/${enc(ogcId)}/role`, {
          role,
        }),
      removeMember: (id: string, ogcId: string) =>
        client.request<undefined>('DELETE', `/v1/groups/${enc(id)}/members/${enc(ogcId)}`),
      leave: (id: string) => post<undefined>(`/v1/groups/${enc(id)}/leave`),
      transfer: (id: string, ogcId: string) =>
        post<undefined>(`/v1/groups/${enc(id)}/transfer`, { ogcId }),
      setArchived: (id: string, archived: boolean) =>
        post<undefined>(`/v1/groups/${enc(id)}/${archived ? 'archive' : 'unarchive'}`),
      delete: (id: string) => client.request<undefined>('DELETE', `/v1/groups/${enc(id)}`),
      invite: (id: string, ogcIds: string[]) =>
        post<InviteResult>(`/v1/groups/${enc(id)}/invitations`, { ogcIds }),
      receivedInvitations: () => get<ReceivedInvitationView[]>('/v1/invitations'),
      acceptInvitation: (id: string) =>
        client.request<{ conversationId: string }>('POST', `/v1/invitations/${enc(id)}/accept`),
      declineInvitation: (id: string) => post<undefined>(`/v1/invitations/${enc(id)}/decline`),
      preferences: (id: string) =>
        get<NotificationPreferences>(`/v1/conversations/${enc(id)}/notifications`),
      setPreferences: (id: string, body: Partial<NotificationPreferences>) =>
        client.request<NotificationPreferences>(
          'PUT',
          `/v1/conversations/${enc(id)}/notifications`,
          body,
        ),
      report: (id: string, body: ConversationReportRequest) =>
        post<{ received: true }>(`/v1/conversations/${enc(id)}/reports`, body),
    },
    links: {
      create: (target: LinkTarget, body: CreateInviteLinkRequest) =>
        post<CreatedInviteLink>(linksPath(target), body),
      list: (target: LinkTarget) => get<InviteLinkView[]>(linksPath(target)),
      revoke: (id: string) => client.request<undefined>('DELETE', `/v1/invite-links/${enc(id)}`),
      preview: (token: string) => post<InvitePreview>('/v1/invite-links/preview', { token }),
      join: (token: string) => post<JoinResult>('/v1/invite-links/join', { token }),
    },
    channels: {
      mine: () => get<ChannelView[]>('/v1/channels'),
      discover: (q: string, cursor?: string) =>
        get<Page<ChannelView>>(`/v1/channels/discover${query({ q: q.trim(), cursor })}`),
      get: (id: string) => get<ChannelView>(`/v1/channels/${enc(id)}`),
      create: (body: CreateChannelRequest) => post<ChannelView>('/v1/channels', body),
      changeVisibility: (id: string, visibility: 'PUBLIC' | 'PRIVATE') =>
        post<VisibilityChangeResult>(`/v1/channels/${enc(id)}/visibility`, {
          visibility,
          confirm: true,
        }),
      join: (id: string) => post<JoinResult>(`/v1/channels/${enc(id)}/join`),
      leave: (id: string) => post<undefined>(`/v1/channels/${enc(id)}/leave`),
      markRead: (id: string, seq: number) =>
        post<undefined>(`/v1/channels/${enc(id)}/read`, { seq }),
      setPreferences: (id: string, body: Partial<NotificationPreferences>) =>
        client.request<NotificationPreferences>(
          'PUT',
          `/v1/channels/${enc(id)}/notifications`,
          body,
        ),
      posts: (id: string, before?: number) =>
        get<ChannelPostPage>(`/v1/channels/${enc(id)}/posts${query({ before })}`),
      pinned: (id: string) => get<ChannelPostView[]>(`/v1/channels/${enc(id)}/pinned`),
      thread: (postId: string) =>
        get<{ post: ChannelPostView; replies: ChannelPostPage }>(
          `/v1/channel-posts/${enc(postId)}/thread`,
        ),
      post: (id: string, body: ChannelPostRequest) =>
        post<ChannelPostView>(`/v1/channels/${enc(id)}/posts`, body),
      deletePost: (postId: string) =>
        client.request<undefined>('DELETE', `/v1/channel-posts/${enc(postId)}`),
      react: (postId: string, reaction: ReactionType, add: boolean) =>
        client.request<undefined>(
          add ? 'PUT' : 'DELETE',
          `/v1/channel-posts/${enc(postId)}/reactions/${enc(reaction)}`,
        ),
      pin: (postId: string, pinned: boolean) =>
        client.request<undefined>(
          pinned ? 'PUT' : 'DELETE',
          `/v1/channel-posts/${enc(postId)}/pin`,
        ),
      moderatePost: (postId: string, removed: boolean, reason?: string) =>
        post<undefined>(
          `/v1/channel-posts/${enc(postId)}/${removed ? 'remove' : 'restore'}`,
          reason ? { reason } : {},
        ),
      reportPost: (postId: string, category: string) =>
        post<{ received: true }>(`/v1/channel-posts/${enc(postId)}/reports`, { category }),
      members: (id: string, status?: 'ACTIVE' | 'PENDING' | 'BANNED') =>
        get<Page<ChannelMemberView>>(`/v1/channels/${enc(id)}/members${query({ status })}`),
      ban: (id: string, ogcId: string, reason?: string) =>
        post<undefined>(`/v1/channels/${enc(id)}/bans/${enc(ogcId)}`, reason ? { reason } : {}),
      unban: (id: string, ogcId: string) =>
        client.request<undefined>('DELETE', `/v1/channels/${enc(id)}/bans/${enc(ogcId)}`, {}),
      suspend: (id: string, ogcId: string, hours: number) =>
        post<undefined>(`/v1/channels/${enc(id)}/members/${enc(ogcId)}/suspend`, { hours }),
      removeMember: (id: string, ogcId: string) =>
        client.request<undefined>('DELETE', `/v1/channels/${enc(id)}/members/${enc(ogcId)}`, {}),
      decideRequest: (id: string, ogcId: string, approve: boolean) =>
        post<undefined>(
          `/v1/channels/${enc(id)}/requests/${enc(ogcId)}/${approve ? 'approve' : 'reject'}`,
        ),
      reports: (id: string) => get<Page<ChannelPostReportView>>(`/v1/channels/${enc(id)}/reports`),
      resolveReport: (reportId: string, outcome: 'RESOLVED' | 'DISMISSED', removePost: boolean) =>
        post<undefined>(`/v1/channel-reports/${enc(reportId)}/resolve`, { outcome, removePost }),
      history: (id: string) =>
        get<Page<ModerationActionView>>(`/v1/channels/${enc(id)}/moderation`),
    },
    notifications: {
      list: (cursor?: string) => get<NotificationPage>(`/v1/notifications${query({ cursor })}`),
      markAllRead: () => post<undefined>('/v1/notifications/read', { all: true }),
    },
  };
}

export type CommunityApi = ReturnType<typeof communityApi>;
