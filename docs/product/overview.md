# Product overview

**OGC — ObagaGlobal Communication** is a modern global communication platform owned by
ObagaGlobal Ltd.

## Core idea

Every user receives a permanent, public **OGC identity** (e.g. `OGC000001`). People find and
contact each other by OGC identity — typically shared by QR code — rather than by phone
number. A user's phone number is never required to be exposed. See
[ogc-identity.md](ogc-identity.md).

## Long-term capability scope

| Area                | Capabilities                                                                            |
| ------------------- | --------------------------------------------------------------------------------------- |
| Identity & accounts | OGC identity, secure authentication, profiles, QR identity sharing                      |
| Social graph        | Contacts, blocking, privacy controls                                                    |
| Messaging           | One-to-one, groups, channels, replies, editing, deletion, forwarding, reactions, search |
| Realtime signals    | Typing indicators, presence, delivered and read receipts                                |
| Media               | Images, files, voice messages                                                           |
| Calls               | Voice and video calls over WebRTC                                                       |
| Devices             | Push notifications, multi-device sessions, device/session management                    |
| Trust & safety      | Reporting, moderation, administrative management                                        |
| Governance          | Role-based access control, audit logging                                                |
| Future              | Business accounts, digital services, external integrations                              |

## Explicitly out of scope

The following are **not** part of the product and must not be designed into it:

- News platform
- Marketplace
- Cryptocurrency or cryptocurrency wallets
- Banking platform or financial exchange
- Mobile network / carrier / telecom infrastructure

Linking a traditional phone number to an account may be considered as a future, optional
feature. It is **not** part of the initial core implementation.

## Design direction

Premium, minimal, and distinctive — explicitly not a generic messaging-app clone.

- Dark / near-black interface with a warm gold accent and neutral supporting colours
- Excellent typography, subtle borders and depth, restrained motion
- The OGC identity is a visually distinctive element (monospaced, gold, generous tracking)
- All visual values come from design tokens in `packages/ui`, so the identity can evolve
  without rewriting applications. Token colour pairs are tested against WCAG 2.2 AA.
