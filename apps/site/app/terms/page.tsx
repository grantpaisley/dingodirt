import Header from "@/components/Header";
import TopoBackdrop from "@/components/TopoBackdrop";

export const metadata = { title: "Terms — dingodirt" };

export default function TermsPage() {
  return (
    <div className="relative min-h-screen">
      <TopoBackdrop />
      <Header />
      <main className="relative z-10 mx-auto max-w-2xl px-6 pb-20 pt-12">
        <h1 className="font-display text-5xl font-black uppercase">
          Terms of use
        </h1>
        <div className="mt-6 flex flex-col gap-5 text-bone-dim">
          <section>
            <h2 className="font-display text-2xl font-bold uppercase text-bone">
              Publishing
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed">
              When you publish a pack you affirm that you have the right to
              share the route and its contents, and that to your knowledge it
              doesn&apos;t direct riders through private property without
              permission or onto illegal trails. Packs you keep private or
              share by link are your correspondence and your responsibility;
              packs listed publicly are reviewed before they appear and may
              be removed at any time.
            </p>
          </section>
          <section>
            <h2 className="font-display text-2xl font-bold uppercase text-bone">
              Riding
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed">
              Routes are shared by community members as-is. Land access,
              legality and conditions change — always check current access
              and local rules before and during a ride. You ride at your own
              risk; dingodirt and pack authors accept no liability for where
              a route takes you.
            </p>
          </section>
          <section>
            <h2 className="font-display text-2xl font-bold uppercase text-bone">
              Takedowns
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed">
              Spotted a route that crosses private property, an illegal
              trail, or anything else that shouldn&apos;t be public? Use the
              Report button on the pack&apos;s page — reports go straight to
              the moderators and problem packs are hidden quickly.
            </p>
          </section>
          <section>
            <h2 className="font-display text-2xl font-bold uppercase text-bone">
              Your data
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed">
              Accounts exist only to own packs; riders browsing or
              downloading need no account. The software is open source
              (AGPL-3.0) — the community&apos;s code is public, your ride
              data is yours.
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
