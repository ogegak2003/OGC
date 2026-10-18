# OGC Bridge: country onboarding checklist

A country is usable only when it is **both** in the code registry
(`BRIDGE_COUNTRY_REGISTRY` in `packages/validation/src/bridge.ts`) **and** listed in
`BRIDGE_COUNTRIES`. Today the registry holds Kenya (`KE`) only, and Kenya has not completed
the legal, commercial and provider items below. See
[bridge-readiness.md](bridge-readiness.md).

## Legal and regulatory

- [ ] Counsel in the country confirms whether OGC needs a licence, registration or a licensed
      partner for click-to-call, and for inbound numbers if planned.
- [ ] Data-protection registration, lawful basis, consent text and cross-border transfer terms
      for telephone numbers and call metadata.
- [ ] Caller-ID presentation rules; anti-spoofing obligations.
- [ ] Consumer rules: price disclosure, billing records, complaints handling.
- [ ] Lawful-interception and data-retention duties identified and allocated (provider or OGC).
- [ ] Taxes on telecommunication services identified.
- [ ] Emergency-services policy: Bridge must not claim to reach emergency numbers.

## Provider and commercial

- [ ] Provider able to operate lawfully in the country, with a signed agreement.
- [ ] Rates for both legs of a click-to-call, SMS rates, and billing increments.
- [ ] Sender ID or short code registered for verification SMS where networks require it.
- [ ] Sandbox tests pass (SMS, call outcomes, webhook signatures) — see the launch criteria in
      bridge-readiness.md.

## Numbering and fraud

- [ ] National numbering plan reviewed: which ranges are mobile, fixed, premium-rate,
      shared-cost, satellite or otherwise high-risk.
- [ ] Prefixes to block added to `BRIDGE_BLOCKED_PREFIXES` (the number-type check already
      refuses premium-rate, shared-cost, VoIP, pager, personal and toll-free numbers as
      classified by `libphonenumber-js`).
- [ ] Tariffs entered in `bridge_tariffs` per prefix, in the settlement currency, as integer
      minor units.
- [ ] Per-account limits reviewed for the market (calls per day, spend cap, maximum duration).

## Software

- [ ] Country added to `BRIDGE_COUNTRY_REGISTRY` with its name; tests for normalisation of
      typical local formats added in `packages/validation/src/bridge.test.ts`.
- [ ] Country added to `BRIDGE_COUNTRIES` in staging; staff end-to-end test with consenting
      staff phones only.
- [ ] Localised consent and disclosure text reviewed.
- [ ] Monitoring dashboards split by country.

## Go-live

- [ ] Sign-off from legal, security and finance recorded.
- [ ] Country added to `BRIDGE_COUNTRIES` in production; first week monitored closely.
