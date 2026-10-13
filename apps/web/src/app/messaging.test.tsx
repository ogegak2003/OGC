import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FakeEngine,
  PEER,
  conversationView,
  fakeMessaging,
  localMessage,
} from '../test/fake-messaging';
import {
  emptyPage,
  json,
  mockApi,
  renderApp,
  signedInRoutes,
  unauthenticated,
} from '../test/helpers';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CONVERSATION = conversationView();
const OPEN = `/messages/${CONVERSATION.id}`;

function setup(engine = new FakeEngine([CONVERSATION]), routes = {}) {
  const messaging = fakeMessaging(engine);
  mockApi({ ...signedInRoutes(), ...routes });
  renderApp(OPEN, messaging.dependencies);
  return messaging;
}

const composer = () => screen.getByRole('textbox', { name: 'Message' });

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Expected element');
  return value;
}

describe('conversation list', () => {
  it('shows conversations with unread counts, presence and a badge in the navigation', async () => {
    const engine = new FakeEngine([conversationView({ unreadCount: 3 })]);
    const messaging = fakeMessaging(engine);
    mockApi(signedInRoutes());
    renderApp('/messages', messaging.dependencies);
    const list = await screen.findByRole('region', { name: 'Conversations' });
    expect(await within(list).findByText('Grace Hopper')).toBeTruthy();
    expect(within(list).getByLabelText('3 unread')).toBeTruthy();
    // Header navigation (wide screens) and tab bar (phones) both show the count.
    for (const nav of screen.getAllByRole('navigation', { name: 'Main' })) {
      expect(within(nav).getByLabelText('3 unread')).toBeTruthy();
    }
  });

  it('starts a conversation with a contact', async () => {
    const engine = new FakeEngine([]);
    const messaging = fakeMessaging(engine);
    mockApi({
      ...signedInRoutes(),
      'GET /api/v1/contacts': () =>
        json({
          items: [
            {
              profile: { ogcId: PEER, displayName: 'Grace Hopper', avatarUrl: null },
              since: new Date().toISOString(),
            },
          ],
          nextCursor: null,
        }),
    });
    renderApp('/messages', messaging.dependencies);
    fireEvent.click(await screen.findByRole('button', { name: 'Start a conversation' }));
    const dialog = await screen.findByRole('dialog', { name: 'New conversation' });
    fireEvent.click(await within(dialog).findByRole('button', { name: /Grace Hopper/ }));
    await waitFor(() => {
      expect(engine.openDirect).toHaveBeenCalledWith(PEER);
    });
    expect(await screen.findByRole('region', { name: /Conversation with/ })).toBeTruthy();
  });

  it('searches only messages stored on this device', async () => {
    const engine = new FakeEngine([CONVERSATION]);
    engine.data.set(CONVERSATION.id, [
      localMessage({ payload: { v: 1, text: 'The launch code is ready' } }),
    ]);
    setup(engine);
    fireEvent.change(await screen.findByRole('searchbox', { name: /Search conversations/ }), {
      target: { value: 'launch' },
    });
    await waitFor(() => {
      expect(engine.search).toHaveBeenCalledWith('launch', 30);
    });
    expect(await screen.findByText('Messages on this device')).toBeTruthy();
    expect(screen.getByText(/never searchable on OGC’s servers/)).toBeTruthy();
  });
});

describe('conversation', () => {
  it('renders text safely, with delivery state, placeholders and reply context', async () => {
    const engine = new FakeEngine([
      conversationView({ peerLastReadSeq: 2, peerLastDeliveredSeq: 2 }),
    ]);
    engine.data.set(CONVERSATION.id, [
      localMessage({ seq: 1, payload: { v: 1, text: '<img src=x onerror=alert(1)>' } }),
      localMessage({
        seq: 2,
        mine: true,
        senderOgcId: 'OGC306841127',
        payload: { v: 1, text: 'Read by Grace' },
      }),
      localMessage({ seq: 3, state: 'deleted', payload: null }),
      localMessage({ seq: 4, state: 'unavailable', payload: null }),
      localMessage({
        seq: 5,
        replyToId: crypto.randomUUID(),
        forwarded: true,
        editedAt: new Date().toISOString(),
      }),
    ]);
    setup(engine);
    const log = await screen.findByRole('log', { name: 'Messages' });
    // Untrusted content is text, never markup.
    expect(await within(log).findByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(log.querySelector('img')).toBeNull();
    expect(within(log).getByRole('img', { name: 'Read' })).toBeTruthy();
    expect(within(log).getByText('This message was deleted')).toBeTruthy();
    expect(within(log).getByText(/Sent before this device joined/)).toBeTruthy();
    expect(within(log).getByText('Original message unavailable')).toBeTruthy();
    expect(within(log).getByText('Forwarded')).toBeTruthy();
    expect(within(log).getByText(/edited/)).toBeTruthy();
  });

  it('sends on Enter, adds a line with Shift+Enter, and signals typing', async () => {
    const messaging = setup();
    const input = await screen.findByRole('textbox', { name: 'Message' });
    fireEvent.change(input, { target: { value: 'Hi Grace' } });
    expect(messaging.realtime.typingCalls).toContainEqual([CONVERSATION.id, true]);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(messaging.engine.send).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(messaging.engine.send).toHaveBeenCalledWith(CONVERSATION.id, { text: 'Hi Grace' });
    });
    expect(
      await within(screen.getByRole('log', { name: 'Messages' })).findByText('Hi Grace'),
    ).toBeTruthy();
    expect(messaging.realtime.typingCalls.at(-1)).toEqual([CONVERSATION.id, false]);
  });

  it('replies, edits, reacts and asks before deleting for everyone', async () => {
    const engine = new FakeEngine([CONVERSATION]);
    const theirs = localMessage({ seq: 1, payload: { v: 1, text: 'Lunch?' } });
    const mine = localMessage({
      seq: 2,
      mine: true,
      senderOgcId: 'OGC306841127',
      payload: { v: 1, text: 'Yes' },
    });
    engine.data.set(CONVERSATION.id, [theirs, mine]);
    setup(engine);
    const log = await screen.findByRole('log', { name: 'Messages' });
    const [theirMenu, myMenu] = await within(log).findAllByRole('button', {
      name: 'Message actions',
    });

    fireEvent.click(required(theirMenu));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reply' }));
    expect(screen.getByText('Replying to')).toBeTruthy();
    fireEvent.change(composer(), { target: { value: 'Sounds good' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => {
      expect(engine.send).toHaveBeenCalledWith(CONVERSATION.id, {
        text: 'Sounds good',
        replyToId: theirs.id,
      });
    });

    fireEvent.click(required(theirMenu));
    fireEvent.click(screen.getByRole('menuitem', { name: 'React with heart' }));
    expect(engine.react).toHaveBeenCalledWith(CONVERSATION.id, theirs.id, 'heart', true);
    // Only your own messages can be edited.
    fireEvent.click(required(theirMenu));
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Delete for everyone' })).toBeNull();

    fireEvent.click(required(myMenu));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    expect((composer() as HTMLTextAreaElement).value).toBe('Yes');
    fireEvent.change(composer(), { target: { value: 'Yes, at 1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save edit' }));
    await waitFor(() => {
      expect(engine.edit).toHaveBeenCalledWith(CONVERSATION.id, mine.id, 'Yes, at 1');
    });

    const [, myMenuAgain] = within(log).getAllByRole('button', { name: 'Message actions' });
    fireEvent.click(required(myMenuAgain));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete for everyone' }));
    expect(engine.deleteForEveryone).not.toHaveBeenCalled();
    const confirm = screen.getByRole('alertdialog', { name: 'Delete for everyone?' });
    expect(within(confirm).getByText(/can’t be recalled/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete for everyone' }));
    await waitFor(() => {
      expect(engine.deleteForEveryone).toHaveBeenCalledWith(CONVERSATION.id, mine.id);
    });
  });

  it('forwards to another conversation', async () => {
    const other = conversationView({
      id: 'c0ffee00-0000-4000-8000-000000000002',
      peer: { ogcId: 'OGC111222333' as never, displayName: 'Ada', avatarUrl: null },
    });
    const engine = new FakeEngine([CONVERSATION, other]);
    const message = localMessage({ payload: { v: 1, text: 'Pass this on' } });
    engine.data.set(CONVERSATION.id, [message]);
    setup(engine);
    fireEvent.click(await screen.findByRole('button', { name: 'Message actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Forward' }));
    const dialog = screen.getByRole('dialog', { name: 'Forward to…' });
    fireEvent.click(within(dialog).getByRole('button', { name: /Ada/ }));
    await waitFor(() => {
      expect(engine.forward).toHaveBeenCalledWith(CONVERSATION.id, message.id, other.id);
    });
  });

  it('shows typing, presence and connection state', async () => {
    const messaging = setup();
    const header = await screen.findByRole('region', { name: 'Conversation with Grace Hopper' });
    expect(await within(header).findByText('Online')).toBeTruthy();
    act(() => {
      messaging.push('message.typing', {
        conversationId: CONVERSATION.id,
        ogcId: PEER,
        typing: true,
      });
    });
    expect(within(header).getAllByText('typing…').length).toBeGreaterThan(0);
    act(() => {
      messaging.setConnection('offline');
    });
    expect(screen.getByText(/Offline — reconnecting/)).toBeTruthy();
  });

  it('disables the composer for a blocked person and offers to unblock', async () => {
    const engine = new FakeEngine([conversationView({ blockedByMe: true })]);
    const unblock = vi.fn(() => json(null, 204));
    setup(engine, { [`DELETE /api/v1/blocks/${PEER}`]: unblock });
    expect(await screen.findByText(/You blocked Grace Hopper/)).toBeTruthy();
    expect((composer() as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Unblock' }));
    await waitFor(() => {
      expect(unblock).toHaveBeenCalled();
    });
  });

  it('shows the safety number in an accessible dialog', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Verify' }));
    const dialog = await screen.findByRole('dialog', { name: 'Verify encryption' });
    expect(await within(dialog).findByLabelText(/Safety number 12345 67890/)).toBeTruthy();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('attachments and voice', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  it('encrypts and uploads files before sending, and shows decrypted photos', async () => {
    const engine = new FakeEngine([CONVERSATION]);
    setup(engine);
    const attach = await screen.findByRole('button', { name: 'Attach files' });
    const fileInput = required(
      attach.parentElement?.querySelector<HTMLInputElement>('input[type=file]'),
    );
    const file = new File([png], 'photo.png', { type: 'image/png' });
    fireEvent.change(fileInput, { target: { files: [file] } });
    expect(screen.getByText(/photo.png/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(engine.uploadAttachment).toHaveBeenCalledWith(
        CONVERSATION.id,
        expect.objectContaining({ kind: 'IMAGE', name: 'photo.png', mime: 'image/png' }),
      );
    });
    expect(await screen.findByRole('img', { name: 'Photo: photo.png' })).toBeTruthy();
  });

  it('never renders a disguised file as an image', async () => {
    const engine = new FakeEngine([CONVERSATION]);
    engine.attachments.set(
      '11111111-1111-4111-8111-111111111111',
      new TextEncoder().encode('<svg onload=alert(1)>'),
    );
    engine.data.set(CONVERSATION.id, [
      localMessage({
        payload: {
          v: 1,
          attachments: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              kind: 'IMAGE',
              name: 'cat.png',
              mime: 'image/png',
              size: 21,
              key: 'A'.repeat(43) + '=',
              nonce: 'A'.repeat(32),
              digest: 'A'.repeat(43) + '=',
            },
          ],
        },
      }),
    ]);
    setup(engine);
    expect(await screen.findByRole('button', { name: 'Download cat.png' })).toBeTruthy();
    expect(screen.queryByRole('img', { name: /Photo/ })).toBeNull();
  });

  it('explains when voice recording is unavailable or denied', async () => {
    vi.stubGlobal('MediaRecorder', undefined);
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Record a voice message' }));
    expect(await screen.findByText(/Voice messages aren’t supported in this browser/)).toBeTruthy();
    cleanup();

    // Recording is supported, but the user refuses microphone access.
    vi.stubGlobal('MediaRecorder', { isTypeSupported: () => true });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) },
    });
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Record a voice message' }));
    expect(await screen.findByText(/Microphone access was denied/)).toBeTruthy();
  });
});

describe('sign-out', () => {
  it('erases this browser’s local messaging data for the account', async () => {
    const messaging = fakeMessaging(new FakeEngine([CONVERSATION]));
    let signedIn = true;
    mockApi({
      ...signedInRoutes(),
      'GET /api/v1/auth/me': () =>
        signedIn
          ? json({
              ogcId: 'OGC306841127',
              displayName: 'Ada',
              email: 'a@example.test',
              emailVerified: true,
              accountStatus: 'ACTIVE',
              createdAt: new Date().toISOString(),
            })
          : unauthenticated(),
      'POST /api/v1/auth/logout': () => {
        signedIn = false;
        return json(null, 204);
      },
      'GET /api/v1/contacts': () => json(emptyPage),
    });
    renderApp('/messages', messaging.dependencies);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => {
      expect(messaging.destroyed).toEqual(['OGC306841127']);
    });
  });
});
