# DingoNav — Monetisation Options

Context: an event with ~800 riders comes soon, and many riders are new to navigation.
The event is a distribution opportunity. The event pack is free under every model.
Riders scan a QR at rego, the link opens, and the pack loads. Riders do not install
an app and do not sign up. The question is what happens *after* the event.

The realistic conversion maths: utility apps convert 2–5% of free users. Thus 800
riders give roughly 20–40 sales, or US$400–800. The event is a seeding play, not a
revenue play, under every option below.

---

## Option 1 — Stay fully free

Everything is free for everyone: packs, aerial, schemes, and the user's own GPX.
This aligns cleanly with the AGPL open-source pivot. There is no payment
infrastructure, no support expectation, and no app store. R2 has no egress fees, so
the hosting costs stay near zero when the user base grows.

- **Pros:** There is zero friction. Adoption and goodwill are at a maximum. The
  story is the simplest ("open and free"). There is nothing to build. There is no
  licensing exposure from paid redistribution.
- **Cons:** There is no revenue to fund the aerial imagery licensing or future work.
  It is harder to add prices later, because users then expect a free product.
  Success gives higher costs with no offset.
- **Good fit if:** The goal is growth of the community and the ecosystem.
  dingodirt.com is the long-term play, and DingoNav is the free on-ramp.

## Option 2 — Freemium, one-off web unlock (~US$20 / A$29.95)

Users consume for free and pay to create. Anyone can open a shared pack forever. A
payment unlocks pack creation from the user's own GPX or Google links, and the
aerial layer. It also unlocks scheme switching (and later the Studio scheme editor)
and larger pack areas.

We sell it as a **web account unlock via Stripe**, not through an app store. This
keeps ~97% of the price. It also keeps the frictionless link flow on the event day.
Frame the price as payment for the *service and data* (hosted aerial, pack hosting,
account and sync), not for the code. That story sits cleanly next to an AGPL repo.

One refinement increases conversion: the free event pack must *include* the aerial
layer and two schemes. Limit them to the corridor of the event route. Riders taste
the paid features on the day. Then they hit the wall when they use the features on
their own tracks.

- **Pros:** The creator/consumer line is clean, and the model is proven (RideWithGPS,
  Strava routes). A one-off US$20 undercuts onX Offroad (~US$30/yr) and Gaia
  (~US$40/yr). The costs support lifetime prices, because a user costs near nothing
  to keep.
- **Cons:** We must build the payment and account plumbing. But the open sign-up
  work on dingodirt.com does most of that. We must check the aerial licensing.
  State open-data imagery (CC-BY) permits paid access. Metromap/Nearmap-class
  imagery does not permit it at this scale. Personal or drone uploads avoid the
  problem fully.
- **Good fit if:** You want revenue without subscriptions and without app stores.

## Option 3 — Native app with in-app purchase

This option has the same freemium split. But we ship it as an iOS/Android app
(likely Capacitor around the existing web app). We sell the unlock through the
stores.

- **Pros:** The app store gives discoverability and trust. It is the only route to
  robust offline storage (iOS can evict PWA storage). It is also the only route to
  background GPS for ride recording.
- **Cons:** Apple and Google take 15–30% (US$20 nets US$14–17), and digital unlocks
  *must* use IAP. An app install is exactly the friction to avoid at a dusty
  staging area with one bar of reception. Review processes make iteration slow.
- **Verdict:** This is a *later* move. Features start it (offline recording, Stark
  phone-as-dash integration), not payments. We do not need a decision now — Option 2
  can add an app wrapper at any time.

## Option 4 — Organiser pays, riders don't

Riders always ride free. Event organisers buy a bulk code (e.g. "every entrant gets
3 months full access") or pay a flat per-event fee. The code covers pack creation,
the aerial layer, and branding for their event.

- **Pros:** Organisers have budgets; most individual riders do not. One sale covers
  hundreds of users. The rider-facing story stays "it's free".
- **Cons:** The number of customers is small, and each customer needs hand-holding.
  Revenue is lumpy and depends on the event season.
- **Note:** This option combines naturally with Option 2 — organiser bulk codes
  become a channel on top of individual unlocks. Or it combines with Option 1 as
  the *only* paid surface.

---

## Feature ideas for a paid tier (Options 2–4)

- Pack creation from the user's own GPX / Google Maps links (multiple sources per pack)
- The aerial imagery layer (this includes personal/drone aerial uploads)
- Scheme switching now; the Dingo Studio scheme editor later
- Larger / unlimited pack corridor areas
- Ride recording + stats, and publish-back to dingodirt.com
- Live location sharing for a group / buddy (a strong appeal for new riders)
- Multi-device sync through an account
- Stark connection (phone-as-dash) — list it as "coming"; do not build it first.
  It needs real engineering for a small slice of users.

## Summary

| | Revenue | Friction | Build effort | AGPL fit |
|---|---|---|---|---|
| 1. Fully free | none | none | none | perfect |
| 2. Web unlock $20 | modest, recurring-ish | low (web, one-off) | payment + account gating | good (sell the service, not the code) |
| 3. Native app IAP | modest minus 15–30% | high at events | app wrapper + store ops | awkward |
| 4. Organiser pays | lumpy | none for riders | bulk codes + sales effort | good |

Options 1 and 2 are the live candidates today. Option 4 layers onto either option.
Option 3 is a follow-on that features start, not a starting point. In each case,
the event runs free.
