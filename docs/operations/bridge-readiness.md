# OGC Bridge: readiness, runbook and launch requirements

Architecture: [architecture/bridge.md](../architecture/bridge.md). Country onboarding:
[bridge-country-onboarding.md](bridge-country-onboarding.md).

**OGC Bridge is not production-ready.** The software is implemented and tested locally against
a simulated provider. It has never sent a real SMS or placed a real call. It must stay
`BRIDGE_ENABLED=false` in production until every item marked _blocked_ or _review_ below is
done.

## Status matrix

### 1. Implemented and tested locally (simulated or scripted provider)

- Feature flag, "disabled" and "not configured" behaviour (API and web).
- Number normalisation, country and number-type rules, masking.
- SMS-code verification: hashing, expiry, attempts, resend cooldown, daily caps, consent.
- Linking, unlinking, opt-in for contact calls, recycled-number takeover.
- Eligibility (contacts only, blocks, opt-in, country, limits) without revealing numbers.
- Click-to-call start, idempotency, concurrency and daily limits, provider outage handling.
- Signed webhooks: forged, stale and malformed rejected; replayed and out-of-order events
  ignored; forward-only state machine; timeouts.
- Ledger: one charge per completed call, no charge for simulated, failed or unanswered calls,
  spend cap, staff adjustments, reconciliation.
- Privacy: other members never see numbers; logs and audit events contain no codes or numbers.
- Web Bridge page (`/calls/bridge`) and Calls-page entry, with simulated labelling.

### 2. Tested with a provider sandbox

- **Nothing.** No provider has been chosen; no sandbox account exists.

### 3. Verified with a real call

- **Nothing.** No real call has been placed.

### 4. Blocked by credentials, contracts or approvals

- Choice of provider and a signed commercial agreement (rates for **both** call legs, SMS
  pricing, number rental, settlement, liability for fraud).
- Provider adapter (`BridgeProvider` implementation), its credentials in the secret store,
  and its webhook signature scheme (the adapter must verify the provider's own signatures).
- Sender ID or short code for verification SMS (registration with networks where required).
- Caller ID presented on the callee's phone (which number, and whether it may be shown).
- Tariffs entered in `bridge_tariffs` from the contract, and a non-zero
  `BRIDGE_DAILY_SPEND_LIMIT_MINOR` once billing is settled.
- Payment collection (not built; charges are recorded only).
- Regulatory position for Kenya (below), confirmed by counsel.
- Mobile app screens (not built; the web page is the only client).
- Inbound calls (design only).

### 5. Requires security or legal review

- Security review of the webhook endpoint, the provider adapter and the fraud rules.
- Data-protection impact assessment for storing telephone numbers (Kenya Data Protection Act 2019) and the consent text shown to members.
- Terms of service and privacy notice updates: Bridge calls are **not end-to-end encrypted**;
  the provider processes call metadata and audio.
- Lawful-interception and record-keeping obligations that may apply to the provider or to OGC.
- Emergency-number policy (Bridge must not be presented as able to reach emergency services).

## Provider options (to be confirmed)

The interface is provider-neutral. The notes below are from general knowledge, **not verified
against current official documentation or commercial offers**; confirm every point with the
provider before choosing.

| Provider (examples)                                         | Expected fit                                                                                     | To confirm                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Africa's Talking                                            | Kenya-based; SMS and voice APIs for East Africa; local sender IDs and numbers.                   | Click-to-call/bridging support, webhook signing, KE rates, KYC, limits. |
| Twilio                                                      | Global voice and SMS APIs; call bridging via call instructions; signed webhooks; many countries. | Kenya voice/SMS availability and rates, sender ID rules, local numbers. |
| Vonage (Nexmo), Infobip, Sinch, others                      | Global voice/SMS platforms with African coverage.                                                | Same as above.                                                          |
| Direct operator interconnect (e.g. a Kenyan mobile network) | Lowest rates, local caller ID.                                                                   | Licensing, contracts and SIP integration effort; longer lead time.      |

Selection criteria: lawful operation in each target country; both-leg pricing; webhook
authenticity (signatures); call-status completeness (busy / no answer / failed); fraud
controls (destination allowlists, spend limits); data residency and DPA terms; support for
local caller ID; SMS deliverability with registered sender IDs; sandbox availability.

## Kenya: regulatory readiness (needs local counsel)

Not legal advice. Items to confirm with Kenyan counsel before launch:

- **Communications Authority of Kenya (CA)** licensing under the **Kenya Information and
  Communications Act (KICA)**: whether OGC needs its own licence (for example an
  applications-service or content-service category) or can rely on a licensed provider's
  licence for click-to-call; numbering rules if OGC ever rents Kenyan numbers (inbound).
- **Data Protection Act, 2019** and the **Office of the Data Protection Commissioner (ODPC)**:
  registration as data controller/processor, lawful basis and consent for telephone numbers,
  cross-border transfer to the provider, retention, data-subject rights, breach notification.
- **Caller identification**: what number may be presented to the callee, and rules against
  spoofing.
- **Consumer protection**: price disclosure before a paid call, billing records, complaints.
- **SIM registration and KYC**: whether verified SMS possession is sufficient, or the provider
  requires more.
- **Lawful interception and retention** duties under Kenyan law for the provider or OGC.
- **Tax** on telecommunication services (for example excise duty and VAT) once charging starts.

## Configuration (variable names only)

`BRIDGE_ENABLED`, `BRIDGE_PROVIDER`, `BRIDGE_COUNTRIES`, `BRIDGE_CODE_SECRET`,
`BRIDGE_WEBHOOK_SECRET`, `BRIDGE_WEBHOOK_TOLERANCE_SECONDS`, `BRIDGE_OUTBOX_DIR`,
`BRIDGE_MAX_CALL_SECONDS`, `BRIDGE_CALLS_PER_DAY`, `BRIDGE_CONCURRENT_CALLS`,
`BRIDGE_DAILY_SPEND_LIMIT_MINOR`, `BRIDGE_BLOCKED_PREFIXES`. Defaults and descriptions:
`apps/api/.env.example`. Production refuses `BRIDGE_PROVIDER=simulated` and requires
`BRIDGE_CODE_SECRET` when Bridge is enabled with a provider. Secrets come from the secret
store only, never from files in the repository.

## Testing locally (simulated, development only)

1. Start the API with, in the shell only (do not edit `.env`):
   `BRIDGE_ENABLED=true BRIDGE_PROVIDER=simulated`.
2. Open `/calls/bridge` in the web app. A banner says calls are simulated.
3. Link a number: use an obviously fictional number in the `+254 7…` range that is not
   anyone's real number. The code is written to `apps/api/.dev-outbox/bridge/` (git-ignored),
   labelled "SIMULATED — no SMS was sent", with the number masked.
4. With two test accounts that are contacts, both linked and the callee opted in, start a
   call. The simulator reports ringing after about 1.5 s, answered after about 4 s and
   completed after 30 s (or the maximum duration). No telephone is contacted and nothing is
   charged.

Automated: `pnpm --filter @ogc/api test -- bridge` (needs the test database) and
`pnpm --filter @ogc/web test -- bridge`.

## Deploy and rollback

- Deploy: apply the migration (`prisma migrate deploy`; additive), deploy the API and web with
  `BRIDGE_ENABLED=false`, verify existing calls and messaging, then enable for staff accounts
  in a staging environment first.
- Rollback: set `BRIDGE_ENABLED=false` and restart. Active calls are left to the provider's own
  timeout; the sweep finalises them when re-enabled. The schema does not need to be rolled back
  (tables stay unused). Do not drop Bridge tables while ledger entries may be needed for
  reconciliation.

## Monitoring and alerts

Watch (audit events and logs, no numbers or codes):

- `BRIDGE_WEBHOOK_REJECTED` rate (forged traffic or a secret mismatch).
- Calls ending `FAILED` with `PROVIDER_UNAVAILABLE` (provider outage).
- `BRIDGE_VERIFICATION_FAILED` and rate-limit responses (code guessing, SMS pumping).
- Daily spend per account and in total versus the provider invoice (reconciliation endpoint).
- Calls swept for exceeding the maximum duration or never acknowledged.

## Incident response

- **Suspected toll fraud or SMS pumping:** set `BRIDGE_ENABLED=false`; add prefixes to
  `BRIDGE_BLOCKED_PREFIXES`; ask the provider to block destinations; review
  `BRIDGE_CALL_REQUESTED` and verification audit events; refund through staff adjustments.
- **Webhook secret leak:** rotate `BRIDGE_WEBHOOK_SECRET` (and the provider's), restart, review
  events accepted since the leak.
- **Code secret leak:** rotate `BRIDGE_CODE_SECRET`; open verifications become invalid; linked
  numbers are unaffected.
- **Number reported as misused:** unlink through support; the owner can re-verify.

## Retention

Bridge records hold personal data (telephone numbers, call metadata). Proposed, subject to the
legal review: verifications deleted after 30 days; revoked numbers anonymised after the dispute
window; call records and ledger entries kept as long as billing and legal obligations require.
The automated retention job does **not** yet cover Bridge tables.

## Launch acceptance criteria

1. Provider chosen, contract signed, sandbox tests pass for: SMS delivery, click-to-call,
   busy, no answer, rejected, failed, provider-initiated hang-up, webhook signature checks.
2. A real call between two consenting staff phones completes with correct states, duration
   and ledger entry, and reconciles with the provider's record.
3. Legal sign-off for Kenya; privacy notice and terms updated; consent text approved.
4. Security review complete; fraud limits and blocked prefixes configured.
5. Mobile screens built (or a decision to launch web-only).
6. Monitoring and alerting in place; incident runbook rehearsed.
