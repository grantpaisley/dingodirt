import Link from "next/link";
import Header from "@/components/Header";
import TopoBackdrop from "@/components/TopoBackdrop";

/**
 * Shown when a page cannot reach the database. It deliberately does not say
 * the pack is missing: a link that still works must not be reported as dead.
 */
export default function ServiceDown({ retry }: { retry?: string }) {
  return (
    <div className="relative min-h-screen">
      <TopoBackdrop />
      <Header />
      <main className="relative z-10 mx-auto max-w-xl px-6 pt-24 text-center">
        <h1 className="font-display text-5xl font-black uppercase">
          Service unavailable
        </h1>
        <p className="mt-4 text-bone-dim">
          dingodirt can&apos;t reach its database right now, so we can&apos;t
          tell you what&apos;s behind this link. Your link is fine — try again
          in a few minutes. The crew has been told.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          {retry && (
            <Link
              href={retry}
              className="inline-block rounded border border-line px-5 py-2.5 transition-colors hover:border-clay hover:text-clay-hot"
            >
              Try again
            </Link>
          )}
          <Link
            href="/"
            className="inline-block rounded border border-line px-5 py-2.5 transition-colors hover:border-clay hover:text-clay-hot"
          >
            ← dingodirt home
          </Link>
        </div>
      </main>
    </div>
  );
}
