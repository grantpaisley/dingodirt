import Link from "next/link";
import Header from "@/components/Header";
import TopoBackdrop from "@/components/TopoBackdrop";

export const metadata = { title: "Get involved — dingodirt" };

const FACEBOOK_GROUP_URL = "https://www.facebook.com/groups/dingodirt";
const GITHUB_ORG_URL = "https://github.com/dingodirt";
const SPONSOR_URL = "https://github.com/sponsors/dingodirt";

const doors = [
  {
    title: "Riders",
    body: "The crew lives in the Facebook group — ride planning, banter, who's-in-for-Sunday. Riding shared packs needs no account here at all.",
    cta: "Join the Facebook group",
    href: FACEBOOK_GROUP_URL,
  },
  {
    title: "Authors",
    body: "Sign in and publish packs — private by default, one link for your mates, public (after a quick review) for everyone. Re-uploads keep the same link.",
    cta: "Publish a pack",
    href: "/publish",
  },
  {
    title: "Developers",
    body: "Everything is AGPL-3.0 on GitHub: the Rust planner, Nav, Studio and this site. Self-host Plan with your own GPX data, file issues, open PRs, or join the Discussions.",
    cta: "GitHub org & Discussions",
    href: GITHUB_ORG_URL,
  },
];

export default function GetInvolvedPage() {
  return (
    <div className="relative min-h-screen">
      <TopoBackdrop />
      <Header />
      <main className="relative z-10 mx-auto max-w-4xl px-6 pb-20 pt-12 sm:px-10">
        <h1 className="font-display text-5xl font-black uppercase">
          Get involved
        </h1>
        <p className="mt-3 max-w-xl text-bone-dim">
          dingodirt is built by riders, for riders — free, open source, and
          open to anyone who wants to ride, share, or build.
        </p>

        <div className="mt-10 grid gap-5 sm:grid-cols-3">
          {doors.map((d) => (
            <div
              key={d.title}
              className="flex flex-col rounded-lg border border-line bg-ink-2/80 p-6"
            >
              <h2 className="font-display text-3xl font-bold uppercase text-clay">
                {d.title}
              </h2>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-bone-dim">
                {d.body}
              </p>
              {d.href.startsWith("/") ? (
                <Link
                  href={d.href}
                  className="mt-5 rounded border border-line px-4 py-2.5 text-center text-sm font-semibold transition-colors hover:border-clay hover:text-clay-hot"
                >
                  {d.cta}
                </Link>
              ) : (
                <a
                  href={d.href}
                  className="mt-5 rounded border border-line px-4 py-2.5 text-center text-sm font-semibold transition-colors hover:border-clay hover:text-clay-hot"
                >
                  {d.cta}
                </a>
              )}
            </div>
          ))}
        </div>

        <div className="mt-12 rounded-lg border border-line bg-ink-2/60 p-6">
          <h2 className="font-display text-2xl font-bold uppercase">
            Keep the lights on
          </h2>
          <p className="mt-2 max-w-xl text-sm text-bone-dim">
            Everything here is free. If dingodirt gets you into the bush and
            back, sponsorship covers the hosting.
          </p>
          <a
            href={SPONSOR_URL}
            className="mt-4 inline-block rounded border border-gum/60 px-5 py-2.5 text-sm font-semibold text-gum transition-colors hover:border-gum hover:text-bone"
          >
            ♥ Sponsor on GitHub
          </a>
        </div>
      </main>
    </div>
  );
}
