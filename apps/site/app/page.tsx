import Link from "next/link";
import Header from "@/components/Header";
import TopoBackdrop from "@/components/TopoBackdrop";

const FACEBOOK_GROUP_URL = "https://www.facebook.com/groups/dingodirt";
const GITHUB_ORG_URL = "https://github.com/dingodirt";

const apps = [
  {
    name: "Dingo Plan",
    tag: "Plot the route",
    blurb:
      "Plan on real trail data — heatmaps of where riders actually go, gates, marks and all. Self-host it with your own GPX library, or wait for hosted Plan.",
    href: "https://plan.dingodirt.com",
    soon: true,
  },
  {
    name: "Dingo Nav",
    tag: "Follow it offline",
    blurb:
      "A PWA on your bars: offline maps, auto-zoom, off-track alerts. No signal, no worries — the pack is already on the phone.",
    href: "https://nav.dingodirt.com",
    soon: false,
  },
  {
    name: "Dingo Studio",
    tag: "Make it yours",
    blurb:
      "Design complete map schemes — colours, trails, HUD — and test-drive them at 30 km/h before the crew rides them.",
    href: "https://studio.dingodirt.com",
    soon: true,
  },
];

export default function Home() {
  return (
    <div className="relative flex-1 overflow-hidden">
      <TopoBackdrop />
      <Header />

      <main className="relative z-10 mx-auto max-w-5xl px-6 sm:px-10">
        {/* Hero */}
        <section className="pt-16 pb-20 sm:pt-24">
          <p
            className="reveal font-display text-lg font-medium uppercase tracking-[0.25em] text-gum"
            style={{ animationDelay: "0.05s" }}
          >
            Open-source trail riding toolkit
          </p>
          <h1
            className="reveal mt-3 max-w-3xl font-display text-6xl font-black uppercase leading-[0.95] sm:text-8xl"
            style={{ animationDelay: "0.15s" }}
          >
            Plan it.
            <br />
            Ride it.
            <br />
            <span className="text-clay">Share it.</span>
          </h1>
          <p
            className="reveal mt-6 max-w-xl text-lg text-bone-dim"
            style={{ animationDelay: "0.3s" }}
          >
            dingodirt is the home of Dingo Plan, Nav and Studio — free and
            open source. Plan routes on real trail data, follow them offline
            on the bars, and share packs with your mates. Riding a shared
            pack needs no account at all.
          </p>
          <div
            className="reveal mt-9 flex flex-wrap items-center gap-4"
            style={{ animationDelay: "0.45s" }}
          >
            <a
              href="https://demo.dingodirt.com"
              className="rounded bg-clay px-6 py-3.5 font-display text-xl font-bold uppercase tracking-wide text-ink transition-colors hover:bg-clay-hot"
            >
              Watch the demo
            </a>
            <Link
              href="/rides"
              className="rounded border border-line px-6 py-3.5 font-display text-xl font-bold uppercase tracking-wide transition-colors hover:border-clay hover:text-clay-hot"
            >
              Browse rides
            </Link>
            <Link
              href="/get-involved"
              className="rounded border border-line px-6 py-3.5 font-display text-xl font-bold uppercase tracking-wide transition-colors hover:border-clay hover:text-clay-hot"
            >
              Get involved
            </Link>
          </div>
        </section>

        {/* Three doors */}
        <section className="border-t border-line py-16">
          <h2 className="font-display text-sm font-medium uppercase tracking-[0.25em] text-bone-dim">
            Three ways in
          </h2>
          <div className="mt-8 grid gap-5 sm:grid-cols-3">
            <Link
              href="/rides"
              className="group rounded-lg border border-line bg-ink-2/80 p-6 transition-all hover:-translate-y-1 hover:border-clay"
            >
              <h3 className="font-display text-3xl font-bold uppercase text-clay">
                Ride
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-bone-dim">
                Browse public packs, tap one, and Nav takes it from there.
                No account, no install, works offline.
              </p>
            </Link>
            <Link
              href="/publish"
              className="group rounded-lg border border-line bg-ink-2/80 p-6 transition-all hover:-translate-y-1 hover:border-clay"
            >
              <h3 className="font-display text-3xl font-bold uppercase text-clay">
                Share
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-bone-dim">
                Sign in and publish packs for your mates — private by
                default, one link to share, public if you want the world in.
              </p>
            </Link>
            <a
              href={GITHUB_ORG_URL}
              className="group rounded-lg border border-line bg-ink-2/80 p-6 transition-all hover:-translate-y-1 hover:border-clay"
            >
              <h3 className="font-display text-3xl font-bold uppercase text-clay">
                Build
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-bone-dim">
                It&apos;s all AGPL on GitHub. Self-host Plan with your own
                data, hack on Nav, or design schemes in Studio.
              </p>
            </a>
          </div>
        </section>

        {/* Apps */}
        <section className="border-t border-line py-16">
          <h2 className="font-display text-sm font-medium uppercase tracking-[0.25em] text-bone-dim">
            Three apps, one ride
          </h2>
          <div className="mt-8 grid gap-5 sm:grid-cols-3">
            {apps.map((app, i) => (
              <a
                key={app.name}
                href={app.href}
                className="group relative rounded-lg border border-line bg-ink-2/80 p-6 transition-all hover:-translate-y-1 hover:border-clay"
                style={{ marginTop: i === 1 ? "-1rem" : undefined }}
              >
                {app.soon && (
                  <span className="absolute right-4 top-4 rounded-full border border-gum/50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-gum">
                    soon
                  </span>
                )}
                <p className="font-display text-base font-medium uppercase tracking-[0.2em] text-clay">
                  {app.tag}
                </p>
                <h3 className="mt-1 font-display text-3xl font-bold uppercase">
                  {app.name}
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-bone-dim">
                  {app.blurb}
                </p>
                <span className="mt-4 inline-block text-sm font-semibold text-clay-hot opacity-0 transition-opacity group-hover:opacity-100">
                  Open →
                </span>
              </a>
            ))}
          </div>
        </section>

        {/* How a pack travels */}
        <section className="border-t border-line py-16">
          <h2 className="font-display text-sm font-medium uppercase tracking-[0.25em] text-bone-dim">
            How a pack travels
          </h2>
          <ol className="mt-8 grid gap-6 sm:grid-cols-4">
            {[
              ["Plan", "Build Sunday's route in Dingo Plan."],
              ["Publish", "One button. Private until you say otherwise."],
              ["Share", "Paste one link in the group chat."],
              ["Ride", "Mates tap it — Nav loads it offline. No accounts."],
            ].map(([title, text], i) => (
              <li key={title} className="relative">
                <span className="font-display text-5xl font-black text-ink-3">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h3 className="mt-1 font-display text-2xl font-bold uppercase text-clay">
                  {title}
                </h3>
                <p className="mt-1.5 text-sm text-bone-dim">{text}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* Community */}
        <section className="border-t border-line py-16">
          <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
            <div>
              <h2 className="font-display text-3xl font-bold uppercase">
                Riders and builders welcome
              </h2>
              <p className="mt-2 max-w-md text-sm text-bone-dim">
                Ride planning and banter live in the Facebook group; code,
                issues and ideas live on GitHub. Both doors are open.
              </p>
            </div>
            <div className="flex gap-3">
              <a
                href={FACEBOOK_GROUP_URL}
                className="rounded border border-line px-6 py-3 font-display text-lg font-bold uppercase tracking-wide transition-colors hover:border-clay hover:text-clay-hot"
              >
                Facebook
              </a>
              <a
                href={GITHUB_ORG_URL}
                className="rounded border border-line px-6 py-3 font-display text-lg font-bold uppercase tracking-wide transition-colors hover:border-clay hover:text-clay-hot"
              >
                GitHub
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="relative z-10 border-t border-line">
        <div className="mx-auto flex max-w-5xl flex-col gap-2 px-6 py-8 text-sm text-bone-dim sm:flex-row sm:items-center sm:justify-between sm:px-10">
          <p className="font-display text-lg font-bold uppercase tracking-wide text-bone">
            dingo<span className="text-clay">dirt</span>
          </p>
          <p className="flex gap-4">
            <a href={GITHUB_ORG_URL} className="hover:text-clay-hot">
              Open source (AGPL-3.0)
            </a>
            <Link href="/terms" className="hover:text-clay-hot">
              Terms
            </Link>
            <Link href="/get-involved" className="hover:text-clay-hot">
              Get involved
            </Link>
          </p>
        </div>
      </footer>
    </div>
  );
}
