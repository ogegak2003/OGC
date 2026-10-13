# Messaging (product behaviour)

What people can do with OGC private messages today, and the rules behind it. Technical
detail: [architecture/messaging.md](../architecture/messaging.md).

## Who can message whom

- You can start a conversation with **your contacts**. There is one conversation per pair of
  people; opening it again returns the same conversation on every device.
- If someone removes you from their contacts, an existing conversation stays open. To stop
  someone contacting you, **block** them.
- Messages from people who aren't contacts ("message requests") are not available yet.

## Privacy

- Messages, photos, files and voice messages are **end-to-end encrypted** on your devices.
  OGC's servers store only encrypted data and cannot read them.
- OGC can see that two accounts exchange messages, when, and roughly how large they are —
  but not what they say. Reactions (👍 ❤️ 😂 😮 😢 🙏) are visible to OGC as a type, not as
  content.
- Notifications on your phone will say only "New message" — never the text.
- **Verify** in a conversation shows a 60-digit safety number. If it matches on both phones,
  nobody (including OGC) has inserted an extra device into your conversation.

## Each device is separate

- Every browser or app you sign in on is its own encrypted device. Messages arrive on all of
  them.
- A newly signed-in device can read messages sent **after** it signed in. Older messages show
  as "Sent before this device joined". (Moving history to a new device securely is planned.)
- Signing out erases that device's messages and keys. Search only covers what is stored on
  the device you are using.

## Sending

- Messages you send while offline wait on your device and go out automatically when you are
  back online — never twice.
- Ticks: ◷ sending · ✓ sent (stored by OGC) · ✓✓ delivered (on their device) · gold ✓✓ read.
- Typing indicators and "Online" are shown only between people in a conversation, and are
  approximate.

## Changing your mind

| Action              | Who    | Time limit | Effect                                                       |
| ------------------- | ------ | ---------- | ------------------------------------------------------------ |
| Edit                | Sender | 48 hours   | Text updated everywhere, marked "edited"                     |
| Delete for me       | Anyone | —          | Removed from your devices only                               |
| Delete for everyone | Sender | 48 hours   | Removed from OGC and from both people's devices              |
| Reactions           | Both   | —          | One of each of six reactions per person; tap again to remove |

Deleting cannot recall copies someone already saved, screenshotted, forwarded or exported —
OGC says so before you confirm.

## Replies, forwarding and attachments

- Reply to a specific message; if the original is gone, the reply shows "Original message
  unavailable".
- Forwarding re-encrypts the message for the new conversation; the recipient sees
  "Forwarded", not who originally wrote it.
- Photos (shown inline), files (downloaded or shared to another app) and voice messages
  (record, stop or cancel; play, pause, seek). Limits: photos and voice 10 MB, other files
  25 MB, voice 15 minutes. If microphone access is refused, OGC explains how to turn it on.

## Blocking

- After you block someone you can't message them, and messages they send are not delivered
  to you — even after you unblock them.
- If someone blocks you, OGC does not tell you: your messages simply are not delivered and
  you won't see them typing or online.
