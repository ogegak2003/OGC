import type {
  ChannelPostView,
  ChannelView,
  ConversationView,
  GroupMemberView,
  OgcId,
} from '@ogc/types';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FakeEngine,
  ME,
  PEER,
  conversationView,
  fakeMessaging,
  localMessage,
} from '../test/fake-messaging';
import { bodyOf, json, mockApi, renderApp, signedInRoutes } from '../test/helpers';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const GROUP_ID = 'c0ffee00-0000-4000-8000-0000000000aa';
const CHANNEL_ID = 'c0ffee00-0000-4000-8000-0000000000cc';
const TOKEN = `ogc_inv_${'k'.repeat(43)}`;

/** The request URL of a recorded fetch call (the app always passes strings). */
const urlOf = (input: unknown): string => (typeof input === 'string' ? input : '');

function groupView(
  overrides: Partial<NonNullable<ConversationView['group']>> = {},
): ConversationView {
  return conversationView({
    id: GROUP_ID,
    type: 'GROUP',
    peer: null,
    group: {
      kind: 'GROUP',
      name: 'Rowing club',
      description: 'Early mornings',
      avatarUrl: null,
      myRole: 'MEMBER',
      memberCount: 3,
      postPolicy: 'ALL_MEMBERS',
      invitePolicy: 'ADMINS',
      archived: false,
      canPost: true,
      ...overrides,
    },
  });
}

const members: GroupMemberView[] = [
  {
    profile: { ogcId: 'OGC111222333' as OgcId, displayName: 'Ada', avatarUrl: null },
    role: 'OWNER',
    joinedAt: '2026-10-13T08:00:00.000Z',
  },
  {
    profile: { ogcId: ME as OgcId, displayName: 'Me', avatarUrl: null },
    role: 'MEMBER',
    joinedAt: '2026-10-13T08:00:00.000Z',
  },
  {
    profile: { ogcId: PEER, displayName: 'Grace Hopper', avatarUrl: null },
    role: 'MEMBER',
    joinedAt: '2026-10-13T08:00:00.000Z',
  },
];

function channel(overrides: Partial<ChannelView> = {}): ChannelView {
  return {
    id: CHANNEL_ID,
    handle: 'night_sky',
    name: 'Night Sky',
    description: 'Astronomy',
    avatarUrl: null,
    visibility: 'PUBLIC',
    joinPolicy: 'OPEN',
    postPolicy: 'ADMINS',
    repliesEnabled: true,
    memberCount: 12,
    version: 5,
    archived: false,
    lastPostAt: null,
    createdAt: '2026-10-13T08:00:00.000Z',
    endToEndEncrypted: false,
    membership: {
      role: 'MEMBER',
      status: 'ACTIVE',
      suspendedUntil: null,
      notificationLevel: 'ALL',
      mutedUntil: null,
      lastReadSeq: 5,
    },
    unreadCount: 0,
    canPost: false,
    canReply: true,
    canModerate: false,
    ...overrides,
  };
}

function post(overrides: Partial<ChannelPostView> = {}): ChannelPostView {
  return {
    id: 'p0000000-0000-4000-8000-000000000001',
    channelId: CHANNEL_ID,
    seq: 3,
    version: 3,
    author: { ogcId: 'OGC111222333' as OgcId, displayName: 'Ada', avatarUrl: null },
    clientPostId: 'p0000000-0000-4000-8000-0000000000c1',
    body: 'Perseids peak tonight',
    replyToId: null,
    replyCount: 2,
    announcement: true,
    pinnedAt: null,
    editedAt: null,
    deletedAt: null,
    removed: false,
    createdAt: '2026-10-13T08:00:00.000Z',
    reactions: [{ reaction: 'heart', count: 4, mine: false }],
    attachments: [],
    ...overrides,
  };
}

describe('groups in messaging', () => {
  it('shows the group name, members count, senders and timeline events', async () => {
    const engine = new FakeEngine([groupView()]);
    engine.data.set(GROUP_ID, [
      localMessage({
        conversationId: GROUP_ID,
        senderOgcId: PEER,
        payload: { v: 1, text: 'See you at 6' },
      }),
    ]);
    engine.events.set(GROUP_ID, [
      {
        id: 'e1',
        type: 'MEMBER_JOINED',
        actor: PEER,
        subject: PEER,
        detail: null,
        createdAt: '2020-01-01T00:00:00.000Z',
        version: 2,
      },
    ]);
    mockApi({
      ...signedInRoutes(),
      [`GET /api/v1/groups/${GROUP_ID}/members`]: () => json(members),
    });
    renderApp(`/messages/${GROUP_ID}`, fakeMessaging(engine).dependencies);
    const panel = await screen.findByRole('region', { name: 'Group: Rowing club' });
    expect(within(panel).getByText('3 members · End-to-end encrypted')).toBeTruthy();
    expect(await within(panel).findByText('Grace Hopper joined')).toBeTruthy();
    expect(within(panel).getByText('See you at 6')).toBeTruthy();
    expect(within(panel).getAllByText('Grace Hopper').length).toBeGreaterThan(0);
  });

  it('hides the composer where only admins may post, and explains why', async () => {
    const engine = new FakeEngine([
      groupView({ kind: 'CHANNEL', postPolicy: 'ADMINS', canPost: false }),
    ]);
    mockApi({
      ...signedInRoutes(),
      [`GET /api/v1/groups/${GROUP_ID}/members`]: () => json(members),
    });
    renderApp(`/messages/${GROUP_ID}`, fakeMessaging(engine).dependencies);
    expect(await screen.findByText('Only admins can post here.')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  });

  it('sends mentions found on the device with the encrypted message', async () => {
    const engine = new FakeEngine([groupView()]);
    mockApi({
      ...signedInRoutes(),
      [`GET /api/v1/groups/${GROUP_ID}/members`]: () => json(members),
    });
    renderApp(`/messages/${GROUP_ID}`, fakeMessaging(engine).dependencies);
    await screen.findByRole('region', { name: 'Group: Rowing club' });
    await waitFor(() => {
      expect(screen.getByText('3 members · End-to-end encrypted')).toBeTruthy();
    });
    // Wait for the member directory, which mentions are matched against.
    await new Promise((resolve) => setTimeout(resolve, 50));
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'Thanks @grace hopper!' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(engine.send).toHaveBeenCalledWith(GROUP_ID, {
        text: 'Thanks @grace hopper!',
        mentions: [PEER],
      });
    });
  });

  it('reports a message, disclosing its text only when the reporter chooses to', async () => {
    const engine = new FakeEngine([groupView()]);
    engine.data.set(GROUP_ID, [
      localMessage({
        conversationId: GROUP_ID,
        senderOgcId: PEER,
        payload: { v: 1, text: 'nasty words' },
      }),
    ]);
    const api = mockApi({
      ...signedInRoutes(),
      [`GET /api/v1/groups/${GROUP_ID}/members`]: () => json(members),
      [`POST /api/v1/conversations/${GROUP_ID}/reports`]: () => json({ received: true }, 202),
    });
    renderApp(`/messages/${GROUP_ID}`, fakeMessaging(engine).dependencies);
    fireEvent.click(await screen.findByRole('button', { name: 'Message actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Report' }));
    const dialog = await screen.findByRole('dialog', { name: 'Report message' });
    expect(within(dialog).queryByText('nasty words')).toBeNull();
    fireEvent.click(within(dialog).getByRole('checkbox'));
    expect(within(dialog).getByText('nasty words')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send report' }));
    await within(dialog).findByText(/your report was sent/);
    const call = api.mock.calls.find(([url]) => urlOf(url).endsWith('/reports'));
    expect(bodyOf(call?.[1])).toMatchObject({
      category: 'HARASSMENT',
      reportedOgcId: PEER,
      disclosedText: 'nasty words',
    });
  });

  it('creates a group with invited contacts', async () => {
    const engine = new FakeEngine([]);
    const api = mockApi({
      ...signedInRoutes(),
      'GET /api/v1/contacts': () =>
        json({
          items: [
            {
              profile: { ogcId: PEER, displayName: 'Grace Hopper', avatarUrl: null },
              since: '2026-10-13T08:00:00.000Z',
            },
          ],
          nextCursor: null,
        }),
      'POST /api/v1/groups': () => json({ conversation: groupView(), invited: [PEER] }, 201),
    });
    renderApp('/messages', fakeMessaging(engine).dependencies);
    fireEvent.click(await screen.findByRole('button', { name: 'New group' }));
    const dialog = await screen.findByRole('dialog', { name: 'New group' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Rowing club' } });
    fireEvent.click(await within(dialog).findByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      const call = api.mock.calls.find(
        ([url, init]) => urlOf(url).endsWith('/v1/groups') && init?.method === 'POST',
      );
      expect(bodyOf(call?.[1])).toEqual({ kind: 'GROUP', name: 'Rowing club', invite: [PEER] });
    });
  });
});

describe('invitation links', () => {
  it('previews from the URL fragment and joins only after confirmation', async () => {
    const engine = new FakeEngine([]);
    const api = mockApi({
      ...signedInRoutes(),
      'POST /api/v1/invite-links/preview': () =>
        json({
          target: 'GROUP',
          id: GROUP_ID,
          name: 'Rowing club',
          description: null,
          avatarUrl: null,
          memberCount: 3,
          alreadyMember: false,
          requiresApproval: false,
          endToEndEncrypted: true,
        }),
      'POST /api/v1/invite-links/join': () =>
        json({ target: 'GROUP', id: GROUP_ID, status: 'JOINED' }),
    });
    renderApp(`/join#token=${TOKEN}`, fakeMessaging(engine).dependencies);
    expect(await screen.findByText('Rowing club')).toBeTruthy();
    // The token is sent in a request body only — never in a URL.
    for (const [url] of api.mock.calls) expect(urlOf(url)).not.toContain(TOKEN);
    expect(api.mock.calls.some(([url]) => urlOf(url).endsWith('/join'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    await waitFor(() => {
      const call = api.mock.calls.find(([url]) => urlOf(url).endsWith('/invite-links/join'));
      expect(bodyOf(call?.[1])).toEqual({ token: TOKEN });
    });
  });

  it('explains an invalid link', async () => {
    mockApi({
      ...signedInRoutes(),
      'POST /api/v1/invite-links/preview': () =>
        json(
          { statusCode: 404, error: 'NOT_FOUND', message: 'x', code: 'INVITATION_INVALID' },
          404,
        ),
    });
    renderApp(`/join#token=${TOKEN}`, fakeMessaging(new FakeEngine([])).dependencies);
    expect(await screen.findByRole('heading', { name: 'Invitation link not valid' })).toBeTruthy();
    expect(screen.getByText(/invalid, has expired or has been used up/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See your invitations' }).getAttribute('href')).toBe(
      '/invitations',
    );
  });

  it('does not call a link expired when the check itself failed', async () => {
    mockApi({
      ...signedInRoutes(),
      'POST /api/v1/invite-links/preview': () =>
        json({ statusCode: 503, error: 'SERVICE_UNAVAILABLE', message: 'x' }, 503),
    });
    renderApp(`/join#token=${TOKEN}`, fakeMessaging(new FakeEngine([])).dependencies);
    expect(await screen.findByText(/could not be checked/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Invitation link not valid' })).toBeNull();
  });
});

describe('community channels', () => {
  const channelRoutes = (view: ChannelView, extra = {}) => ({
    ...signedInRoutes(),
    [`GET /api/v1/channels/${CHANNEL_ID}`]: () => json(view),
    [`GET /api/v1/channels/${CHANNEL_ID}/posts`]: () => json({ items: [post()], nextCursor: null }),
    [`GET /api/v1/channels/${CHANNEL_ID}/pinned`]: () => json([]),
    ...extra,
  });

  it('labels channels as not end-to-end encrypted and explains posting rights', async () => {
    mockApi(channelRoutes(channel()));
    renderApp(`/channels/${CHANNEL_ID}`, fakeMessaging(new FakeEngine([])).dependencies);
    expect(await screen.findByText(/Not end-to-end encrypted/)).toBeTruthy();
    expect(await screen.findByText('Perseids peak tonight')).toBeTruthy();
    expect(screen.getByText('Announcement')).toBeTruthy();
    expect(screen.getByText('Admins write posts here; you can reply and react.')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Write a post' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
  });

  it('lets admins post announcements', async () => {
    const api = mockApi(
      channelRoutes(
        channel({
          canPost: true,
          canModerate: true,
          membership: {
            role: 'ADMIN',
            status: 'ACTIVE',
            suspendedUntil: null,
            notificationLevel: 'ALL',
            mutedUntil: null,
            lastReadSeq: 5,
          },
        }),
        { [`POST /api/v1/channels/${CHANNEL_ID}/posts`]: () => json(post(), 201) },
      ),
    );
    renderApp(`/channels/${CHANNEL_ID}`, fakeMessaging(new FakeEngine([])).dependencies);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Write a post' }), {
      target: { value: 'Clouds tonight' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /Announcement/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Post' }));
    await waitFor(() => {
      const call = api.mock.calls.find(
        ([url, init]) => urlOf(url).endsWith('/posts') && init?.method === 'POST',
      );
      expect(bodyOf(call?.[1])).toMatchObject({ body: 'Clouds tonight', announcement: true });
    });
    expect(screen.getByRole('button', { name: 'Manage' })).toBeTruthy();
  });

  it('shows removed posts as placeholders to members', async () => {
    mockApi(
      channelRoutes(channel(), {
        [`GET /api/v1/channels/${CHANNEL_ID}/posts`]: () =>
          json({ items: [post({ removed: true, body: null, reactions: [] })], nextCursor: null }),
      }),
    );
    renderApp(`/channels/${CHANNEL_ID}`, fakeMessaging(new FakeEngine([])).dependencies);
    expect(await screen.findByText('Removed by a moderator')).toBeTruthy();
    expect(screen.queryByText('Perseids peak tonight')).toBeNull();
  });

  it('shows a clear message for channels that are unavailable', async () => {
    mockApi({
      ...signedInRoutes(),
      [`GET /api/v1/channels/${CHANNEL_ID}`]: () =>
        json(
          { statusCode: 404, error: 'NOT_FOUND', message: 'Channel not found', code: 'NOT_FOUND' },
          404,
        ),
      [`GET /api/v1/channels/${CHANNEL_ID}/posts`]: () =>
        json(
          { statusCode: 404, error: 'NOT_FOUND', message: 'Channel not found', code: 'NOT_FOUND' },
          404,
        ),
      [`GET /api/v1/channels/${CHANNEL_ID}/pinned`]: () =>
        json(
          { statusCode: 404, error: 'NOT_FOUND', message: 'Channel not found', code: 'NOT_FOUND' },
          404,
        ),
    });
    renderApp(`/channels/${CHANNEL_ID}`, fakeMessaging(new FakeEngine([])).dependencies);
    expect(
      await screen.findByText('This channel doesn’t exist or isn’t available to you.'),
    ).toBeTruthy();
  });

  it('searches the public directory', async () => {
    mockApi({
      ...signedInRoutes(),
      'GET /api/v1/channels': () => json([]),
      'GET /api/v1/channels/discover': () =>
        json({ items: [channel({ membership: null })], nextCursor: null }),
      'GET /api/v1/channels/discover?q=night': () =>
        json({ items: [channel({ membership: null })], nextCursor: null }),
    });
    renderApp('/channels', fakeMessaging(new FakeEngine([])).dependencies);
    expect(await screen.findByText(/You haven’t joined any channels yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Discover' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search public channels' }), {
      target: { value: 'night' },
    });
    expect(await screen.findByRole('link', { name: 'Night Sky' })).toBeTruthy();
  });
});

describe('notifications', () => {
  it('lists notifications in plain language and marks them read', async () => {
    const api = mockApi({
      ...signedInRoutes(),
      'GET /api/v1/notifications': () =>
        json({
          items: [
            {
              id: 'n1',
              type: 'GROUP_INVITATION',
              data: { groupName: 'Rowing club', invitationId: 'i1', inviter: 'OGC111222333' },
              readAt: null,
              createdAt: '2026-10-13T08:00:00.000Z',
            },
            {
              id: 'n2',
              type: 'CHANNEL_ANNOUNCEMENT',
              data: { channelId: CHANNEL_ID, channelName: 'Night Sky', postId: 'p1' },
              readAt: null,
              createdAt: '2026-10-13T08:00:00.000Z',
            },
          ],
          nextCursor: null,
          unread: 2,
        }),
      'POST /api/v1/notifications/read': () => json(undefined, 204),
    });
    renderApp('/notifications', fakeMessaging(new FakeEngine([])).dependencies);
    expect(await screen.findByRole('link', { name: 'You’re invited to Rowing club' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'New announcement in Night Sky' })).toBeTruthy();
    await waitFor(() => {
      const call = api.mock.calls.find(([url]) => urlOf(url).endsWith('/notifications/read'));
      expect(bodyOf(call?.[1])).toEqual({ all: true });
    });
  });
});
