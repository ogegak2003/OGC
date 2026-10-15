# Push notifications: setup, testing and operations

Design: [architecture/notifications.md](../architecture/notifications.md).

## What you need

| Piece                          | Needed for                    | Where it lives                                                          |
| ------------------------------ | ----------------------------- | ----------------------------------------------------------------------- |
| OGC development/release build  | Any push on a phone           | `pnpm --filter @ogc/mobile android:build debug` or EAS (not Expo Go)    |
| Expo project                   | Expo push tokens              | `@obagaglobal-ltd/ogc`, ID in `app.config.ts` (`extra.eas.projectId`)   |
| Firebase project + FCM V1 key  | Android delivery              | `google-services.json` in the build; FCM service-account key **in EAS** |
| Apple Developer + APNs key     | iOS delivery                  | APNs key **in EAS** (paid Apple Developer Program)                      |
| `PUSH_PROVIDER=expo`           | API sends to Expo             | `apps/api/.env` / deployment secrets                                    |
| `EXPO_ACCESS_TOKEN` (optional) | Expo "enhanced push security" | API secret only — never in the app                                      |

None of these credentials are in the repository; example values are placeholders.

## API configuration

```dotenv
# apps/api/.env (placeholders)
PUSH_PROVIDER=expo                 # disabled | outbox (development files) | expo
# EXPO_ACCESS_TOKEN=replace-with-expo-access-token   # only if enhanced push security is on
# Queue tuning (defaults shown)
# PUSH_WORKER_INTERVAL_MS=1000
# PUSH_BATCH_SIZE=100
# PUSH_MAX_ATTEMPTS=5
# PUSH_RETRY_BASE_MS=5000
# PUSH_RECEIPT_DELAY_SECONDS=900
# PUSH_DELIVERY_RETENTION_DAYS=7
# RATE_LIMIT_PUSH_REGISTER=20
```

`PUSH_PROVIDER=outbox` writes each push (token redacted) as JSON under `PUSH_OUTBOX_DIR` —
use it to see what would be sent without any credentials. The queue lives in PostgreSQL
(`push_deliveries`): no extra service. Redis is still required in production for the existing
reasons (presence decides which devices are "online", rate limits, fan-out).

## Android credentials (FCM V1)

1. In the [Firebase console](https://console.firebase.google.com) create (or pick) a project
   and add an **Android app** with package `com.obagaglobal.ogc`. Download
   `google-services.json` (git-ignored; never commit it).
2. Local builds: keep the file outside the repo and point the build at it:
   `$env:GOOGLE_SERVICES_JSON = "C:\secure\google-services.json"` before
   `pnpm --filter @ogc/mobile android:build debug`.
   EAS builds: `npx eas-cli@24.13.0 env:create --environment development --name GOOGLE_SERVICES_JSON --type file --value C:\secure\google-services.json --visibility secret`
   (repeat for `preview`/`production`).
3. Firebase console → Project settings → Service accounts → **Generate new private key** (JSON).
   Upload it to Expo: `cd apps/mobile; npx eas-cli@24.13.0 credentials --platform android`
   → Google Service Account → _Manage your Google Service Account Key for Push Notifications
   (FCM V1)_ → upload. Delete the local copy afterwards (or keep it in a password manager).
4. Rebuild the app (the Firebase file is compiled in).

## iOS credentials (APNs)

Requires the paid **Apple Developer Program** on the account that owns
`com.obagaglobal.ogc`. Run `npx eas-cli@24.13.0 credentials --platform ios` interactively and
let EAS create a **push key** (or upload an existing `.p8` APNs key); EAS enables the Push
Notifications capability (the `aps-environment` entitlement comes from the
`expo-notifications` config plugin). Then build with EAS (`--profile preview` for a device).
Not done or tested yet: there is no Apple Developer membership on this project.

## Testing on a physical Android phone

1. Complete **Android credentials** above and set `PUSH_PROVIDER=expo` in `apps/api/.env`;
   restart the API (`pnpm --filter @ogc/api dev`).
2. Build and install: `$env:OGC_ANDROID_ABIS = "arm64-v8a"; $env:GOOGLE_SERVICES_JSON = "<path>"; pnpm --filter @ogc/mobile android:build debug`,
   then `adb install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`.
3. Start Metro (`$env:REACT_NATIVE_PACKAGER_HOSTNAME = "<PC Wi-Fi IPv4>"; pnpm --filter @ogc/mobile dev`),
   open the app, sign in as account **B**, and allow notifications when asked
   (or You → Notification settings → Allow notifications).
4. Check the registration: `docker exec ogc-postgres-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select device_id, provider, left(token, 22) as token_prefix, updated_at from push_tokens order by updated_at desc limit 3;"'`.
5. Put the app in the **background** (home button) or close it. From the web app signed in as
   account **A**, send B a message, a contact request, or call B.
6. Expected: "OGC — New message" (or "Incoming call", "New contact request") within seconds;
   tapping opens the conversation / contacts. Turn on **Show sender** to see the name instead.
7. Inspect what happened: `select category, status, attempts, last_error, created_at from push_deliveries order by created_at desc limit 10;`
   (`SENT` = Expo accepted; `DELIVERED` = receipt confirmed ~15 min later; `FAILED` with
   `last_error` explains why).

Automated tests use mocked providers (`apps/api/test/push-notifications.test.ts`,
`apps/mobile/src/notifications.test.tsx`); they do not prove real delivery.

## Troubleshooting

| Symptom                                                      | Likely cause / fix                                                                                                            |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Settings says "Push notifications need the OGC app build"    | Running in Expo Go — install the development build                                                                            |
| No row in `push_tokens` after allowing                       | Missing Firebase (`google-services.json`) in the build → `Default FirebaseApp is not initialized`; rebuild                    |
| Rows `FAILED` with `InvalidCredentials` / `MismatchSenderId` | FCM V1 key not uploaded to EAS, or from another Firebase project                                                              |
| Rows `FAILED` with `DeviceNotRegistered`; token removed      | App uninstalled / data cleared — reopen the app to register again                                                             |
| Rows stay `PENDING` with `HTTP_429`/`HTTP_5xx`/`NETWORK`     | Expo or network trouble — retried automatically with backoff                                                                  |
| No row in `push_deliveries` at all                           | The device was online (app open), the person turned that category off, the conversation is muted, or `PUSH_PROVIDER=disabled` |
| Arrives late or not at all on some phones                    | Battery optimisation / OEM app killers — exempt OGC in system settings                                                        |

## Monitoring

`GET /api/v1/metrics`: `ogc_push_deliveries_total{category,outcome}` (queued, sent, delivered,
retried, failed, expired), `ogc_push_errors_total{code}`, `ogc_push_queue_pending`,
`ogc_push_queue_oldest_pending_seconds` (alert if it keeps growing),
`ogc_rate_limited_total`. Logs carry error codes only — never tokens or content.

## Production checklist

- HTTPS for the API (tokens and settings travel over authenticated TLS).
- `PUSH_PROVIDER=expo`; FCM V1 key and APNs key in EAS; `GOOGLE_SERVICES_JSON` as an EAS file
  variable per environment; optional `EXPO_ACCESS_TOKEN` as a server secret.
- Redis configured (presence decides when to push); alerting on queue age and failure rate.
