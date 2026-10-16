import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEngine, PEER, conversationView, fakeMessaging } from '../test/fake-messaging';
import { json, mockApi, renderApp, signedInRoutes } from '../test/helpers';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CONVERSATION = conversationView();

function open(routes = {}) {
  const engine = new FakeEngine([CONVERSATION]);
  const messaging = fakeMessaging(engine);
  mockApi({ ...signedInRoutes(), ...routes });
  renderApp(`/messages/${CONVERSATION.id}`, messaging.dependencies);
  return engine;
}

describe('messaging workspace', () => {
  it('opens a details panel with the person’s identity and actions', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Show details' }));
    const details = await screen.findByRole('complementary', { name: 'Details: Grace Hopper' });
    expect(within(details).getByText('Grace Hopper')).toBeTruthy();
    expect(within(details).getByText(/End-to-end encrypted/)).toBeTruthy();
    expect(within(details).getByRole('link', { name: 'View profile' }).getAttribute('href')).toBe(
      `/id/${PEER}`,
    );
    expect(within(details).getByRole('link', { name: 'Report' }).getAttribute('href')).toBe(
      `/report/${PEER}`,
    );
    expect(window.localStorage.getItem('ogc.messages.details')).toBe('true');

    fireEvent.click(within(details).getByRole('button', { name: 'Verify safety number' }));
    expect(await screen.findByRole('dialog', { name: 'Verify encryption' })).toBeTruthy();
  });

  it('blocks only after confirmation, through the existing block endpoint', async () => {
    const block = vi.fn(() => json(null, 204));
    open({ [`POST /api/v1/blocks/${PEER}`]: block });
    fireEvent.click(await screen.findByRole('button', { name: 'Show details' }));
    const details = await screen.findByRole('complementary', { name: /Details/ });
    fireEvent.click(within(details).getByRole('button', { name: 'Block' }));
    expect(block).not.toHaveBeenCalled();
    const confirm = within(details).getByRole('group', { name: 'Confirm block' });
    expect(within(confirm).getByText(/They are not told/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Block' }));
    await waitFor(() => {
      expect(block).toHaveBeenCalledTimes(1);
    });
  });

  it('hides the conversation list to give the conversation the room, and remembers it', async () => {
    open();
    const toggle = await screen.findByRole('button', { name: 'Hide conversation list' });
    fireEvent.click(toggle);
    expect(await screen.findByRole('button', { name: 'Show conversation list' })).toBeTruthy();
    expect(window.localStorage.getItem('ogc.messages.listCollapsed')).toBe('true');
  });
});
