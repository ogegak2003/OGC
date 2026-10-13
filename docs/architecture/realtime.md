# Realtime

Decision: [ADR-023](decisions.md#adr-023-socketio-for-realtime-with-a-versioned-closed-event-contract),
[ADR-026](decisions.md#adr-026-presence-and-typing-are-ephemeral).
Status: **Implemented** unless marked otherwise.

## Transport

Socket.IO 4.8 through `@nestjs/platform-socket.io`, path **`/api/realtime`** (proxied with
the REST API by nginx and the Vite dev server), namespace **`/v1`** = protocol version 1.
Client payloads are limited to 16 KiB; ping every 25 s. With `REDIS_URL` set, the Socket.IO
Redis adapter fans events out across API instances (tested with two instances sharing Redis).

Realtime is an accelerator, not a source of truth: every event describes state already
committed to PostgreSQL, and clients run a sync after every (re)connection.

## Authentication and authorization

| Step             | Rule                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Handshake origin | Browsers must come from an allowlisted Origin (`CORS_ORIGINS` + `WEB_APP_URL`); native apps send none                                                        |
| Credentials      | Native: bearer access token in the handshake `auth`. Web: the HttpOnly access cookie **plus** an allowlisted Origin (cross-site WebSocket hijacking defence) |
| Session          | Same `SessionService.authenticate` as REST; only ACTIVE accounts                                                                                             |
| Rate limit       | Connections per client IP (honouring `TRUST_PROXY_HOPS` only) and per account                                                                                |
| Expiry           | The socket is closed when the access token expires; the client refreshes and reconnects                                                                      |
| Revocation       | Logout/reuse detection publishes `session.revoked`; that session's sockets are disconnected                                                                  |
| Identity         | `socket.data` = user, OGC ID, session, device — **never** taken from payloads                                                                                |
| Rooms            | `user:<id>`, `device:<id>`, `session:<id>`, `presence:<id>` — joined by the server only                                                                      |
| Events           | Closed contract: an unknown client event name disconnects the socket; every payload is Zod-validated                                                         |

The HTTP `AuthGuard` and throttler apply to HTTP only; WebSocket handlers do their own
per-event authorization (participant + no block) and rate limiting.

## Event contract v1 (`@ogc/types` `ServerToClientEvents` / `ClientToServerEvents`)

Server → client:

| Event                                       | Payload (summary)                  | Audience                                     |
| ------------------------------------------- | ---------------------------------- | -------------------------------------------- |
| `conversation.created`                      | conversation view                  | Both participants                            |
| `conversation.updated`                      | id, version                        | Participants                                 |
| `message.created` / `.updated` / `.deleted` | message envelope (ciphertext only) | Sender's devices; recipient unless withheld  |
| `message.reaction`                          | message id, version, reactions     | Both (not across a block)                    |
| `message.hidden`                            | message id, version                | The hiding user's devices only               |
| `message.delivered` / `message.read`        | conversation, OGC ID, seq          | Own devices; peer unless blocked             |
| `message.typing`                            | conversation, OGC ID, typing       | The other participant                        |
| `presence.updated`                          | OGC ID, ONLINE/OFFLINE             | Subscribers allowed to see it                |
| `mls.commit`                                | conversation, epoch, version       | Participants                                 |
| `mls.welcome`                               | conversation                       | The added device                             |
| `devices.changed`                           | conversation                       | Participants (most recent 200 conversations) |

Client → server: `typing.start`, `typing.stop` (`{conversationId}`), `presence.subscribe`
(`{ogcIds ≤ 100}`, acknowledged with states), `presence.unsubscribe`.

## Typing (ephemeral)

Never stored in PostgreSQL. Allowed only for participants with no block in either direction
(checked, then cached for 15 s per socket). Rate-limited per account
(`RATE_LIMIT_TYPING`/min). The server ends an indicator after 8 s without a refresh or when
the socket disconnects; clients also expire it (8 s) and clear it when a message arrives.

## Presence (approximate)

ONLINE while at least one connection of the account is alive; OFFLINE otherwise. Stored in
Redis sorted sets (in memory without Redis) with 90 s expiry refreshed every 30 s, so a
crashed instance cannot leave users "online". Never written to PostgreSQL. A client may
subscribe only to accounts it shares a conversation with and that have not blocked (and are
not blocked by) it — other IDs are silently ignored, so presence cannot be used to probe
accounts. Presence is shown as "Online" only; there is no "last seen". Presence privacy
settings: Planned.

## Scaling

- Single instance: everything works in memory.
- Multiple instances (`REDIS_URL` required in production): Socket.IO Redis adapter, shared
  presence, shared rate limits. Sticky sessions are not required with the WebSocket transport
  (the mobile client uses WebSocket only; browsers may fall back to long-polling, which does
  need sticky sessions at the load balancer).
