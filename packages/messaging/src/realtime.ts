import {
  type ClientToServerEvents,
  type OgcId,
  type PresenceView,
  REALTIME_NAMESPACE,
  REALTIME_PATH,
  type ServerToClientEvents,
} from '@ogc/types';
import { type Socket, io } from 'socket.io-client';

export type RealtimeSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export type ConnectionState = 'connecting' | 'online' | 'offline';

export interface RealtimeOptions {
  /** API origin, e.g. `https://ogc.example` or '' for same-origin (web). */
  origin: string;
  /**
   * Native clients: returns a fresh access token for each (re)connection.
   * Web clients omit it: the HttpOnly session cookie authenticates the socket.
   */
  accessToken?: () => Promise<string | undefined>;
  /** Called when the server rejects the session; refresh the token, then the socket retries. */
  onUnauthorized?: () => Promise<void>;
  onState?: (state: ConnectionState) => void;
  /** Native apps use WebSocket only; browsers may fall back to long-polling. */
  transports?: ('websocket' | 'polling')[];
}

const SERVER_EVENTS: (keyof ServerToClientEvents)[] = [
  'conversation.created',
  'conversation.updated',
  'message.created',
  'message.updated',
  'message.deleted',
  'message.reaction',
  'message.hidden',
  'message.delivered',
  'message.read',
  'message.typing',
  'presence.updated',
  'mls.commit',
  'mls.welcome',
  'devices.changed',
  'group.created',
  'group.updated',
  'group.member_joined',
  'group.member_left',
  'group.member_removed',
  'group.role_changed',
  'group.invitation_created',
  'group.invitation_revoked',
  'group.deleted',
  'channel.created',
  'channel.updated',
  'channel.member_joined',
  'channel.member_left',
  'channel.post_created',
  'channel.post_updated',
  'channel.post_deleted',
  'channel.post_pinned',
  'channel.announcement_created',
  'channel.access_revoked',
  'community.notification',
];

/**
 * A realtime connection with automatic reconnection (exponential backoff with
 * jitter). The server closes sockets when the access token expires; the
 * client then refreshes and reconnects. Realtime is only an accelerator: after
 * every (re)connection callers should run a sync to recover anything missed.
 */
export class RealtimeConnection {
  readonly socket: RealtimeSocket;
  private state: ConnectionState = 'connecting';

  constructor(
    private readonly options: RealtimeOptions,
    onEvent: <E extends keyof ServerToClientEvents>(
      event: E,
      payload: Parameters<ServerToClientEvents[E]>[0],
    ) => void,
    onReconnect: () => void,
  ) {
    this.socket = io(`${options.origin}${REALTIME_NAMESPACE}`, {
      path: REALTIME_PATH,
      withCredentials: true,
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 30_000,
      randomizationFactor: 0.5,
      ...(options.transports ? { transports: options.transports } : {}),
      ...(options.accessToken
        ? {
            auth: (callback: (data: object) => void) => {
              void (options.accessToken?.() ?? Promise.resolve(undefined)).then((token) => {
                callback(token ? { token } : {});
              });
            },
          }
        : {}),
    });
    for (const event of SERVER_EVENTS) {
      this.socket.on(event, ((payload: never) => {
        onEvent(event, payload);
      }) as never);
    }
    this.socket.on('connect', () => {
      this.setState('online');
      onReconnect();
    });
    this.socket.on('disconnect', (reason) => {
      this.setState('offline');
      // The server closed the socket (token expired or session revoked): refresh, then reconnect.
      if (reason === 'io server disconnect') {
        void (this.options.onUnauthorized?.() ?? Promise.resolve()).then(() =>
          this.socket.connect(),
        );
      }
    });
    this.socket.on('connect_error', (error) => {
      this.setState('offline');
      if (error.message === 'unauthorized') void this.options.onUnauthorized?.();
    });
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onState?.(state);
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  connect(): void {
    this.socket.connect();
  }

  disconnect(): void {
    this.socket.disconnect();
  }

  typing(conversationId: string, typing: boolean): void {
    if (this.socket.connected)
      this.socket.emit(typing ? 'typing.start' : 'typing.stop', { conversationId });
  }

  async subscribePresence(ogcIds: OgcId[]): Promise<PresenceView[]> {
    if (!this.socket.connected || ogcIds.length === 0) return [];
    const response = await new Promise<
      Parameters<Parameters<ClientToServerEvents['presence.subscribe']>[1]>[0]
    >((resolve) => {
      this.socket.emit('presence.subscribe', { ogcIds }, resolve);
    });
    return response.ok ? response.data : [];
  }

  unsubscribePresence(ogcIds: OgcId[]): void {
    if (this.socket.connected && ogcIds.length)
      this.socket.emit('presence.unsubscribe', { ogcIds });
  }
}
