# OGC design system

One visual language for the web app and the Android/iOS apps: premium black and gold,
calm surfaces, and the OGC ID as the signature element. Everything below lives in
`packages/ui` and is consumed by both clients, so the identity can evolve in one place.

## Tokens (`packages/ui/src/tokens`)

| Group      | Notes                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------- |
| Colour     | Semantic roles only in application code (`color.surface`, `color.accent`, …). See below. |
| Typography | System font stacks (no font CDN); scale `xs` 12 → `4xl` 44; mono stack for OGC IDs.      |
| Layout     | 4px spacing grid; radii `sm` 8, `md` 12, `lg` 16, `xl` 24; `size.touch` 44 (min target). |
| Motion     | 120–320ms, standard/enter/exit easing; honour reduced-motion (both clients do).          |

Web receives the tokens as CSS custom properties (`--ogc-color-surface-raised`, …) generated
by `toCssVariables()`; mobile imports the same objects.

### Colour roles

| Role                                   | Value                             | Use                                                                 |
| -------------------------------------- | --------------------------------- | ------------------------------------------------------------------- |
| `background`                           | `#0B0B0D`                         | App canvas                                                          |
| `surface` / `surfaceRaised`            | `#121214` / `#19191D`             | Panels, lists, bars / cards, inputs, sheets                         |
| `surfaceHover`                         | `#2A2A2F`                         | Pressed and hovered rows                                            |
| `border` / `borderStrong`              | `#232328` / `#34343A`             | Hairlines / control outlines                                        |
| `textPrimary` / `Secondary` / `Muted`  | `#F5F3EE` / `#B5B0A6` / `#9B968C` | Warm white and greys                                                |
| `accent`                               | `#D8AD4E`                         | Primary actions, selected navigation, unread counts                 |
| `accentHighlight`                      | `#F0D48B`                         | Champagne: OGC IDs, identity text                                   |
| `accentSubtle` / `accentBorder`        | `#1C170E` / `#5A441B`             | The identity card and selected rows — the only gold-tinted surfaces |
| `success`, `warning`, `danger`, `info` | with `…Subtle` backgrounds        | Status, notices and destructive actions                             |

Gold is reserved for primary actions, the selected destination, identity highlights and
important states. Every text/background pair used is tested against WCAG 2.2 AA in
`packages/ui/src/tokens.test.ts` (4.5:1 for text, 3:1 for non-text).

## Icons (`packages/ui/src/icons.ts`)

A single outline icon set on a 24×24 grid (round caps, 1.75 stroke) defined as SVG path
data, rendered by `apps/web/src/components/Icon.tsx` (DOM SVG, `currentColor`) and
`apps/mobile/src/components/Icon.tsx` (`react-native-svg`). Icons are decorative: the
control that contains them carries the accessible name. Emoji are used only for content
(message reactions and the emoji picker), never as interface icons.

## Components

| Concern   | Mobile (`apps/mobile/src/components`)                                                       | Web (`apps/web/src/components`)                                 |
| --------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Actions   | `Button` (primary/secondary/ghost/danger, icon), `IconButton`                               | `Button` (same variants, icon)                                  |
| Forms     | `Field` (label, icon, hint, error, password reveal), `SwitchRow`                            | `TextField`, `PasswordField`                                    |
| Feedback  | `Notice` (+ Retry action), `Skeleton`, `SkeletonRows`, `Loading`                            | `Alert`, `Skeleton`, `Spinner`                                  |
| Structure | `Card`, `ListGroup` + `ListRow`, `SectionHeader`, `Tabs`, `Tag`, `EmptyState`, `CountBadge` | CSS modules per area                                            |
| Identity  | `Avatar` (photo or tinted initials), `OgcIdText`, `IdentityCard`, `OgcQrCode`               | `Avatar`, `OgcQrCode`                                           |
| Layout    | `Screen` / `AppBar` / `AuthScreen` (safe areas), `TabBar`                                   | `AppShell` (sidebar ≥1024px, top + tab bar below), `AuthLayout` |

## Navigation

The same five destinations on every platform:

| Destination | Mobile tab  | Web                      | Contents                                                             |
| ----------- | ----------- | ------------------------ | -------------------------------------------------------------------- |
| Home        | Home        | `/home`                  | Greeting, OGC ID card (copy, share, QR), quick actions, recent chats |
| Chats       | Chats       | `/messages`              | All conversations (direct, groups, encrypted channels)               |
| Contacts    | Contacts    | `/contacts`              | Contacts, requests, sent requests                                    |
| Communities | Communities | `/communities`           | Groups and community channels; create, invitations, join by link     |
| You / More  | You         | sidebar, or "More" sheet | Profile, notifications, discovery, privacy, security, sign-out       |

Notifications are one tap away from Home (bell with the real unread count). Mobile Search
(`search` route) covers chats, contacts, channels, on-device message text and exact OGC ID
lookup. Android back pops the stack, then returns to Home, then leaves the app.

## Honesty rules

- Message previews are the latest message as decrypted on this device; otherwise an honest
  placeholder ("Encrypted message", "Message could not be displayed").
- "End-to-end encrypted" appears only for direct conversations and groups (MLS); community
  channels always say they are not end-to-end encrypted.
- Online dots and typing indicators come only from realtime presence/typing events.
- Profile completion is computed from the profile (photo, bio; the display name is required).
- Features without a backend (managing other sessions, calls) are described as not available
  yet rather than shown as working controls.
