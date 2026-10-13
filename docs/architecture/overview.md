# Architecture overview

## Shape: a modular monolith

OGC starts as **one deployable API** (`apps/api`) internally divided into **domain modules**
with explicit boundaries, plus web and mobile clients. This keeps development, deployment,
transactions, and debugging simple while the product is young, and leaves a clear path to
extract a module into its own service when scale or team structure demands it
([ADR-001](decisions.md#adr-001-modular-monolith)).

```text
              ┌──────────────┐     ┌──────────────┐
              │  Web (Vite)  │     │ Mobile (Expo)│
              └──────┬───────┘     └──────┬───────┘
                     │  HTTPS (REST)  +  WebSocket (Socket.IO, later)
              ┌──────▼────────────────────▼───────┐
              │            OGC API (NestJS)        │
              │  ┌──────────┐ ┌──────────┐ ┌─────┐ │
              │  │ Identity │ │Messaging │ │ ... │ │   domain modules
              │  └────┬─────┘ └────┬─────┘ └──┬──┘ │
              │  ─────┴────────────┴──────────┴─── │
              │   platform: config · logging ·     │
              │   database · security · errors     │
              └──────┬──────────────────────┬──────┘
                     │                      │
              ┌──────▼──────┐        ┌──────▼──────────────┐
              │ PostgreSQL  │        │ Later: Redis, object │
              │  (Prisma)   │        │ storage, TURN, push  │
              └─────────────┘        └─────────────────────┘
```

## Module boundary rules

Enforced by review now and by lint rules (import restrictions) once modules exist:

1. Each domain lives in `apps/api/src/modules/<domain>/` and exposes a **public service
   interface** through its Nest module's `exports`. Other modules use only that.
2. A module **owns its tables**. Other modules never query them directly; they call the
   owning module's service. This is what makes later extraction possible.
3. Cross-module side effects (e.g. "message sent" → notifications, audit) go through
   **domain events**, not direct calls into the other module's internals.
4. Platform concerns (`config/`, `database/`, `common/`) contain no business logic.
5. Shared client/server contracts live in `packages/types` and `packages/validation`,
   never imported from app internals.

## Domain modules

Implemented so far: **Identity**, **Authentication**, **Audit** (Phase 1); **Profiles**,
**Contacts**, **Privacy/Blocks**, **Reports**, and the shared **Relationships** service
(Phase 2); **Conversations/Messaging**, **E2EE device keys**, **Attachments**, **Realtime**
and **Notifications** (Phase 3); **Groups**, **Channels** (community), invitation links and
in-app notifications in the **Community** module (Phase 4); plus `Email`, `Storage`, `Redis` and `Metrics` platform
pieces. See [identity-and-authentication.md](identity-and-authentication.md),
[social-graph.md](social-graph.md), [messaging.md](messaging.md),
[encryption.md](encryption.md), [realtime.md](realtime.md), [sync.md](sync.md),
[groups.md](groups.md), [channels.md](channels.md),
[community-encryption.md](community-encryption.md) and [data-model.md](data-model.md).

| Module             | Responsibility                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------- |
| **Identity**       | Issues and resolves permanent OGC identities; internal ID ↔ public OGC ID mapping           |
| **Authentication** | Credentials, password hashing, login, token/session issuance and rotation, MFA later        |
| **Profiles**       | Display name, avatar, bio, profile visibility                                               |
| **Contacts**       | Contact lists, discovery by OGC identity and QR, contact requests                           |
| **Messaging**      | Conversations, messages, replies, edits, deletions, forwarding, reactions, search, receipts |
| **Groups**         | Group conversations, membership, group roles and permissions                                |
| **Channels**       | One-to-many broadcast channels, subscribers, admins                                         |
| **Media**          | Uploads, storage, content scanning, thumbnails, voice messages, signed download URLs        |
| **Realtime**       | Authenticated WebSocket gateway, fan-out, presence, typing; Redis adapter when scaled out   |
| **Calls**          | WebRTC signalling, call state, TURN credential issuance                                     |
| **Notifications**  | Push (APNs/FCM via Expo), in-app notifications, preferences                                 |
| **Devices**        | Device registration, multi-device sessions, session listing and revocation                  |
| **Privacy**        | Visibility rules (last seen, profile, read receipts), blocking enforcement                  |
| **Moderation**     | User reports, review queues, enforcement actions                                            |
| **Administration** | Internal admin console APIs, staff roles                                                    |
| **Audit**          | Append-only security and administrative event log                                           |

Cross-cutting: **Authorization (RBAC)** is a platform capability used by every module —
guards plus policy checks in services — not a module that others reach into.

## API conventions

- Base path `/api`, URI versioning: `/api/v1/...`
- Liveness `GET /api/v1/health` (process only); readiness `GET /api/v1/health/ready`
  (checks the database, `503` when unavailable).
- Errors always use the `ApiErrorBody` shape from `@ogc/types`; 5xx details are never
  exposed. Every response carries an `X-Request-Id` that matches the server logs.
- All configuration comes from validated environment variables (`src/config/env.schema.ts`).
- Every route requires authentication unless marked `@Public()`; handlers take identity only
  from `@CurrentAuth()`.
- Request bodies are validated with shared Zod schemas (`ZodValidationPipe`); unknown fields
  are rejected. Errors carry a stable `code` (e.g. `INVALID_CREDENTIALS`).

## Data

PostgreSQL via Prisma 7 (driver adapter `@prisma/adapter-pg`). Phase 1 introduced the first
models (users, profiles, credentials, devices, sessions, verification tokens, audit events) —
see [data-model.md](data-model.md). Guidelines:

- Internal primary keys are UUIDs (v7 for index locality); OGC identities are a separate
  unique column.
- Every table has `created_at` / `updated_at`; soft deletion only where product rules
  need it.
- Migrations are forward-only in shared environments and reviewed like code.

## Realtime and calls

- **Realtime (Phase 3):** a Socket.IO gateway inside the API at `/api/realtime`
  (namespace `/v1`), authenticated at connection time with the same sessions as REST; rooms
  per user, device and session; the Redis adapter, shared presence and shared rate limits
  when `REDIS_URL` is set. See [realtime.md](realtime.md).
- **Calls:** WebRTC media flows peer-to-peer (or via TURN); the API only provides
  signalling over the realtime channel and issues short-lived TURN credentials. A media
  server (SFU) is considered only if group calls require it.

## Clients

- **Web** — React + Vite SPA. Design tokens are compiled into CSS custom properties at
  build time (no inline styles, so a strict CSP is possible).
- **Mobile** — Expo / React Native. Uses the same tokens as typed values.
- Both consume `@ogc/types` and `@ogc/validation`, so contracts and rules are shared, and
  both run the same end-to-end encrypted messaging engine (`@ogc/messaging` on top of
  `@ogc/e2ee`), differing only in storage (IndexedDB vs files + Keychain/Keystore) and
  transport (cookies vs bearer tokens).

## Deployment shape

Production images are defined in `infrastructure/docker/`: the API runs as a non-root Node
process with a read-only filesystem; the web client is static files served by unprivileged
nginx with strict security headers and a same-origin `/api` proxy (including WebSocket
upgrades for `/api/realtime`). Redis (no persistence) holds shared ephemeral state; it is
required in production. Hosting platform is not yet chosen.
