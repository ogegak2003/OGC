# OGC design system

One visual language for the web app and the Android and iOS apps. It uses calm Obsidian
surfaces, restrained champagne accents and strong typography, with the OGC ID as the signature
element. The source of truth lives in `packages/ui` and both clients consume it, so the identity
evolves in one place.

**2026-10 redesign.**

- The globe imagery and globe-based mark are gone. The mark is now a ring around a quiet core.
- The palette is Obsidian, Charcoal, Champagne, Ivory, Emerald, Coral and Slate.
- There is a complete theme system: dark and light modes, three accents, and a System option.

## Brand palette (`packages/ui/src/tokens/color.ts`)

| Name                 | Value     | Role                                             |
| -------------------- | --------- | ------------------------------------------------ |
| Obsidian             | `#101114` | Dark canvas; text on light accents               |
| Elevated charcoal    | `#1B1D22` | Raised dark surfaces (cards, inputs, sheets)     |
| Champagne gold       | `#D6B46A` | Default accent: primary actions, selection, IDs  |
| Warm ivory           | `#F4F1E8` | Light canvas; primary text in dark mode          |
| Emerald              | `#36B889` | Success, online presence; optional accent        |
| Coral                | `#F07878` | Errors, destructive actions, missed calls (dark) |
| Slate                | `#858B98` | Offline presence, secondary chart series         |
| Blue Steel (support) | `#7FA6D8` | Information; optional accent                     |

## Themes

A theme is a **mode** × an **accent**, resolved by `resolveTheme(mode, accent)` into semantic
roles. Application code only ever uses the roles.

| Choice | Options                                                             | Default   |
| ------ | ------------------------------------------------------------------- | --------- |
| Mode   | **Obsidian** (dark), **Ivory** (light), **System** (follows device) | Obsidian  |
| Accent | **Champagne**, **Emerald**, **Blue Steel**                          | Champagne |

Roles:

- **Canvas and surfaces:** `background`, `surface`, `surfaceRaised`, `surfaceHover`, `border`,
  `borderStrong`.
- **Text:** `textPrimary`, `textSecondary`, `textMuted`, `textDisabled`.
- **Accent:** `accent`, `accentHover`, `accentPressed`, `accentHighlight`, `accentSubtle`,
  `accentBorder`, `onAccent`, `focusRing`.
- **Status:** `success`, `warning`, `danger`, `info`, each with a `…Subtle` background.
- **Presence:** `online`, `offline`.
- **Charts and overlays:** `chartSecondary`, `chartGrid`, `scrim`.

Every theme (2 modes × 3 accents) is tested against WCAG 2.2 AA in
`packages/ui/src/tokens.test.ts`: 4.5:1 for text roles on every surface and tint, and 3:1 for
focus, status, presence, accent and chart colours.

**Web.**

- `toCssVariables()` emits `--ogc-*` custom properties: the default theme on `:root`, and one
  block per `[data-theme][data-accent]` pair.
- `ThemeProvider` (`apps/web/src/theme`) sets those attributes on `<html>`, so the whole app
  switches at once. The saved choice (`localStorage`, `ogc.appearance`) is applied before the
  first paint.
- The call stage pins `data-theme="dark"` on its own subtree.

**Mobile.**

- `apps/mobile/src/theme` holds one live `color` object, updated in place.
- Style sheets are wrapped in `themedStyles(() => StyleSheet.create(…))`, which rebuilds them
  after a change.
- `ThemeProvider` saves the choice with `expo-secure-store` and follows the device for System.
  Screens are keyed by the theme, so they rebuild. The navigation stack and the messaging
  session survive.
- The call screen uses `stage`: always dark, with the current accent.

Choices are made in **Settings → Appearance** on both platforms. The web account menu also
offers them.

**Rules.**

- Accents are restrained. Use them for primary actions, the selected destination, identity
  highlights and unread emphasis. Gold gradients appear only in the logo.
- No hard-coded colours in components. The exceptions are the always-dark video stage,
  shadows, and the avatar initial tints, which have a set per mode.

## Other tokens

| Group      | Notes                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------- |
| Typography | System font stacks (no font CDN); scale `xs` 12 → `4xl` 44; mono stack for OGC IDs.      |
| Layout     | 4px spacing grid; radii `sm` 8, `md` 12, `lg` 16, `xl` 24; `size.touch` 44 (min target). |
| Elevation  | Per mode (`elevations.dark`, `elevations.light`).                                        |
| Motion     | 120–320 ms, standard/enter/exit easing.                                                  |

## Motion

Animations are short and purposeful:

- message arrival;
- the details panel;
- charts;
- the welcome content;
- sidebar collapse;
- the theme transition;
- the online "live" dot.

**Rule:** an entrance animation moves content but never starts it invisible, so paused or
throttled animations cannot hide anything. Reduced motion turns animations off on the web
(global rule) and on mobile (`useReducedMotion`). Nothing waits for an animation before sending
or navigating.

## Icons (`packages/ui/src/icons.ts`)

There is one outline icon set on a 24×24 grid (round caps, 1.75 stroke). It is rendered on the
web as DOM SVG and on mobile through `react-native-svg`. Icons are decorative: the control that
contains them carries the accessible name.

- **Added in the redesign:** `sun`, `moon`, `palette`, `sidebar`, `panelRight`, `barChart` and
  `compass`.
- **Removed:** `globe`. `compass` now marks public channels.

## Components

| Concern   | Mobile (`apps/mobile/src`)                                                                  | Web (`apps/web/src/components`)                                                                    |
| --------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Actions   | `Button` (primary/secondary/ghost/danger, icon), `IconButton`                               | `Button` (same variants, icon); **Create** menu in the top bar                                     |
| Forms     | `Field`, `SwitchRow`                                                                        | `TextField`, `PasswordField`                                                                       |
| Feedback  | `Notice`, `Skeleton`, `SkeletonRows`, `Loading`                                             | `Alert`, `Skeleton`, `Spinner`                                                                     |
| Structure | `Card`, `ListGroup` + `ListRow`, `SectionHeader`, `Tabs`, `Tag`, `EmptyState`, `CountBadge` | CSS modules per area                                                                               |
| Identity  | `Avatar`, `OgcIdText`, `IdentityCard`, `OgcQrCode`, `OgcLogo`                               | `Avatar`, **`IdentityCard`** (OGC ID, copy, share, QR, privacy), `OgcQrCode`, `OgcLogo`, `OgcMark` |
| Theme     | **`AppearanceScreen`**, `ThemeProvider`                                                     | **`ThemeControls`** (radio groups), `ThemeProvider`                                                |
| Data      | —                                                                                           | **`BarChart`** (SVG, tokens, focusable days, tooltip, screen-reader table)                         |
| Messaging | Conversation screens                                                                        | Workspace: list, conversation and **`ConversationDetails`** (collapsible list and details)         |
| Layout    | `Screen` / `AppBar` / `AuthScreen` (safe areas), `TabBar`                                   | `AppShell` (collapsible sidebar ≥1024px; top bar and tab bar below), `AuthLayout`                  |

## Navigation

| Destination | Mobile tab  | Web                                | Contents                                                                                      |
| ----------- | ----------- | ---------------------------------- | --------------------------------------------------------------------------------------------- |
| Home        | Home        | `/home`                            | Welcome, numbers at a glance, quick actions, activity, calls chart, identity card, online now |
| Messages    | Chats       | `/messages`                        | Conversations (direct, groups, encrypted channels)                                            |
| Contacts    | Contacts    | `/contacts`                        | Contacts, requests, sent requests                                                             |
| Groups      | Communities | `/communities`                     | Groups; create, invitations, join by link                                                     |
| Channels    | Communities | `/channels`                        | Community channels                                                                            |
| Calls       | from Home   | `/calls`                           | Call history and starting calls                                                               |
| You         | You         | sidebar "You", or the "More" sheet | Profile, Appearance, Security and devices, Privacy, Notification settings, Blocked            |

The web sidebar collapses to an icon rail (remembered per browser), and links keep their names
as tooltips. On mobile, Android back pops the stack, then returns to Home, then leaves the app.

## Data visualisation

- **Calls chart (Home):** calls per day for the last 14 days, split into answered, missed and
  not connected.
  - It is built only from the account's call history returned by `GET /v1/calls` (its most
    recent 50 calls), and says so.
  - Bars start at zero, and the axis uses round numbers.
  - Empty and error states are explicit.
- **Message volume:** there is no message-volume chart. The server stores only ciphertext
  metadata, and no privacy-reviewed aggregate exists. A chart computed on the device would need
  its own design.

## Honesty rules

- Message previews are the latest message as decrypted on this device; otherwise an honest
  placeholder.
- "End-to-end encrypted" appears only for direct conversations and groups (MLS). Community
  channels always say they are not end-to-end encrypted.
- Online dots and typing indicators come only from realtime presence and typing events.
- Dashboard numbers each link to their source and show "—" when it cannot be loaded. Nothing is
  estimated or invented.
- Features without a backend are described as not available rather than shown as working
  controls.
