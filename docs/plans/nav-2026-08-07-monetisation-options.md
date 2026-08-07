# DingoNav — Monetisation Options

Context: an upcoming event with ~800 riders (many new to navigation) is a distribution
opportunity. Whatever the model, the event pack is free — riders scan a QR at rego,
the link opens, the pack loads. No install, no sign-up. The question is what happens
*after* the event.

Realistic conversion maths: utility apps convert 2–5% of free users. 800 riders →
roughly 20–40 sales → US$400–800. The event is a seeding play, not a revenue play,
under every option below.

---

## Option 1 — Stay fully free

Everything free for everyone: packs, aerial, schemes, own GPX. Aligns cleanly with
the AGPL open-source pivot. No payment infrastructure, no support expectations, no
app store. R2 has no egress fees, so hosting costs stay near zero even with growth.

- **Pros:** zero friction, maximum adoption and goodwill, simplest story ("open and
  free"), nothing to build, no licensing exposure on paid redistribution.
- **Cons:** no revenue to fund aerial imagery licensing or future work; harder to
  introduce pricing later once "it's free" is the expectation; success = higher costs
  with no offset.
- **Good fit if:** the goal is community/ecosystem growth and dingodirt.com is the
  long-term play, with DingoNav as the free on-ramp.

## Option 2 — Freemium, one-off web unlock (~US$20 / A$29.95)

Consume free, create paid. Anyone can open a shared pack forever. Paying unlocks:
building packs from their own GPX / Google links, the aerial layer, scheme switching
(and eventually the Studio scheme editor), larger pack areas.

Sold as a **web account unlock via Stripe**, not through an app store — keeps ~97%
of the price and preserves the frictionless event-day link flow. Frame it as paying
for the *service and data* (hosted aerial, pack hosting, account/sync), not the code —
that sits cleanly alongside an AGPL repo.

Refinement that drives conversion: the free event pack should *include* aerial and a
couple of schemes, corridor-limited to the event route. Riders taste the paid
features on the day, then hit the wall trying to use them on their own tracks.

- **Pros:** clean creator/consumer line (proven model — RideWithGPS, Strava routes);
  one-off US$20 undercuts onX Offroad (~US$30/yr) and Gaia (~US$40/yr); costs support
  lifetime pricing since a user costs near-nothing to keep.
- **Cons:** payment + account plumbing to build (though open sign-up work on
  dingodirt.com gets most of the way); aerial licensing must be checked — state
  open-data imagery (CC-BY) is fine to resell access to, Metromap/Nearmap-class
  imagery is not at this scale; personal/drone uploads sidestep it entirely.
- **Good fit if:** you want revenue without subscriptions and without app stores.

## Option 3 — Native app with in-app purchase

Same freemium split, but shipped as an iOS/Android app (likely Capacitor wrapping
the existing web app) with the unlock sold through the stores.

- **Pros:** app store discoverability and trust; the only route to robust offline
  (iOS can evict PWA storage) and background GPS for ride recording.
- **Cons:** Apple/Google take 15–30% (US$20 nets US$14–17) and digital unlocks *must*
  use IAP; app install is exactly the friction to avoid at a dusty staging area with
  one bar of reception; review processes slow iteration.
- **Verdict:** a *later* move, triggered by features (offline recording, Stark
  phone-as-dash integration), not by payments. Doesn't need deciding now — Option 2
  can add an app wrapper any time.

## Option 4 — Organiser pays, riders don't

Riders always ride free. Event organisers buy a bulk code (e.g. "every entrant gets
3 months full access" or a flat per-event fee) covering pack creation, aerial, and
branding for their event.

- **Pros:** organisers have budgets, individual riders mostly don't; one sale covers
  hundreds of users; keeps the rider-facing story "it's free".
- **Cons:** small number of customers, each needing hand-holding; revenue is lumpy
  and event-season dependent.
- **Note:** combines naturally with Option 2 — organiser bulk codes as a channel on
  top of individual unlocks — or with Option 1 as the *only* paid surface.

---

## Feature ideas for a paid tier (Options 2–4)

- Pack creation from own GPX / Google Maps links (multiple sources per pack)
- Aerial imagery layer (incl. personal/drone aerial uploads)
- Scheme switching now; Dingo Studio scheme editor later
- Larger / unlimited pack corridor areas
- Ride recording + stats, publish-back to dingodirt.com
- Live group / buddy location sharing (strong appeal for new riders)
- Multi-device sync via account
- Stark connection (phone-as-dash) — list as "coming" rather than build first;
  real engineering for a small slice of users

## Summary

| | Revenue | Friction | Build effort | AGPL fit |
|---|---|---|---|---|
| 1. Fully free | none | none | none | perfect |
| 2. Web unlock $20 | modest, recurring-ish | low (web, one-off) | payment + account gating | good (sell service, not code) |
| 3. Native app IAP | modest minus 15–30% | high at events | app wrapper + store ops | awkward |
| 4. Organiser pays | lumpy | none for riders | bulk codes + sales effort | good |

Options 1 and 2 are the live candidates today; 4 layers onto either; 3 is a
feature-driven follow-on, not a starting point. Either way the event runs free.
