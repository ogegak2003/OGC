import type { GroupSecurityEvent } from '@ogc/messaging';
import type { ConversationView, GroupMemberView, OgcId } from '@ogc/types';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeEngine, ME, PEER, conversationView, fakeMessaging } from '../test/fake-messaging';
import { json, mockApi, renderApp, signedInRoutes } from '../test/helpers';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const GROUP_ID = 'c0ffee00-0000-4000-8000-0000000000ab';

const group: ConversationView = conversationView({
  id: GROUP_ID,
  type: 'GROUP',
  peer: null,
  group: {
    kind: 'GROUP',
    name: 'Rowing club',
    description: null,
    avatarUrl: null,
    myRole: 'MEMBER',
    memberCount: 2,
    postPolicy: 'ALL_MEMBERS',
    invitePolicy: 'ADMINS',
    archived: false,
    canPost: true,
  },
});

const members: GroupMemberView[] = [
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

function securityEvent(overrides: Partial<GroupSecurityEvent> = {}): GroupSecurityEvent {
  return {
    id: '3:new-device:' + PEER,
    epoch: 3,
    change: 'new-device',
    level: 'verify',
    ogcId: PEER,
    devices: 1,
    via: 'member',
    by: PEER,
    acknowledged: false,
    ...overrides,
  };
}

function setup(events: GroupSecurityEvent[]) {
  const engine = new FakeEngine([group]);
  engine.security.set(GROUP_ID, events);
  mockApi({
    ...signedInRoutes(),
    [`GET /api/v1/groups/${GROUP_ID}/members`]: () => json(members),
  });
  renderApp(`/messages/${GROUP_ID}`, fakeMessaging(engine).dependencies);
  return engine;
}

describe('group security warnings', () => {
  it('asks to verify a member’s new key, offers the comparison, and dismisses', async () => {
    const engine = setup([securityEvent()]);
    const banner = await screen.findByRole('alert', { name: 'Group security' });
    await waitFor(() => {
      expect(banner.textContent).toMatch(/Grace Hopper has a new security key in this group/);
    });
    expect(banner.textContent).toMatch(/Security keys changed in this group/);
    expect(banner.textContent).not.toMatch(/attack|compromised/i);

    fireEvent.click(within(banner).getByRole('button', { name: 'Compare safety numbers' }));
    expect(await screen.findByRole('dialog', { name: 'Verify encryption' })).toBeTruthy();
    expect(engine.safetyNumber).toHaveBeenCalledWith(GROUP_ID, PEER);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    fireEvent.click(within(banner).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => {
      expect(engine.acknowledgeGroupSecurity).toHaveBeenCalledWith(GROUP_ID);
    });
    await waitFor(() => {
      expect(screen.queryByRole('alert', { name: 'Group security' })).toBeNull();
    });
  });

  it('uses cautious wording for changes this device could not check', async () => {
    setup([
      securityEvent({
        id: '9:resynced:',
        epoch: 9,
        change: 'resynced',
        level: 'unconfirmed',
        ogcId: null,
        via: 'rejoin',
        by: null,
      }),
    ]);
    const banner = await screen.findByRole('alert', { name: 'Group security' });
    expect(banner.textContent).toMatch(/couldn’t be checked on this device/);
    expect(banner.textContent).not.toMatch(/Security keys changed/);
    expect(within(banner).queryByRole('button', { name: 'Compare safety numbers' })).toBeNull();
  });

  it('shows nothing for ordinary, confirmed membership changes', async () => {
    setup([
      securityEvent({
        id: '2:member-joined:' + PEER,
        change: 'member-joined',
        level: 'confirmed',
        acknowledged: true,
      }),
    ]);
    await screen.findByRole('region', { name: 'Group: Rowing club' });
    expect(screen.queryByRole('alert', { name: 'Group security' })).toBeNull();
  });

  it('lists each pending change, offering a comparison only with other people', async () => {
    setup([securityEvent(), securityEvent({ id: '4:new-device:' + ME, ogcId: ME })]);
    const banner = await screen.findByRole('alert', { name: 'Group security' });
    await waitFor(() => {
      expect(within(banner).getAllByRole('listitem')).toHaveLength(2);
    });
    // Own account: advice to check devices, no comparison with oneself.
    expect(banner.textContent).toMatch(/your account/);
    expect(within(banner).getAllByRole('button', { name: 'Compare safety numbers' })).toHaveLength(
      1,
    );
  });
});
