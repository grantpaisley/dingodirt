import Link from "next/link";
import Header from "@/components/Header";
import TopoBackdrop from "@/components/TopoBackdrop";
import CopyLinkButton from "@/components/CopyLinkButton";
import ReportButton from "@/components/ReportButton";
import ServiceDown from "@/components/ServiceDown";
import { reportOutage } from "@/lib/alert";
import { packByToken, currentVersionOf } from "@/lib/packs";
import { currentUser } from "@/lib/membership";
import PlanView from "./PlanView";

export const metadata = { title: "Pack — dingodirt" };

export default async function PackPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // A database failure is not a retracted link. Say so, and tell the crew,
  // instead of turning an outage into "No longer shared".
  let pack;
  try {
    pack = await packByToken(token);
  } catch (err) {
    await reportOutage(`/p/${token}`, err);
    return <ServiceDown retry={`/p/${token}`} />;
  }

  const user = await currentUser();
  const isOwner = !!pack && !!user && pack.ownerId === user.id;

  // Private packs are visible only to their owner.
  if (!pack || (pack.visibility === "private" && !isOwner)) {
    return (
      <div className="relative min-h-screen">
        <TopoBackdrop />
        <Header />
        <main className="relative z-10 mx-auto max-w-xl px-6 pt-24 text-center">
          <h1 className="font-display text-5xl font-black uppercase">
            No longer shared
          </h1>
          <p className="mt-4 text-bone-dim">
            This pack link isn&apos;t live — the author may have made it
            private or retracted it. Ask them for a fresh link.
          </p>
          <Link
            href="/"
            className="mt-8 inline-block rounded border border-line px-5 py-2.5 transition-colors hover:border-clay hover:text-clay-hot"
          >
            ← dingodirt home
          </Link>
        </main>
      </div>
    );
  }

  const version = await currentVersionOf(pack.id, pack.currentVersion);
  const downloadPath = `/api/packs/${pack.shareToken}/download`;
  const meta = version?.metadata
    ? (JSON.parse(version.metadata) as Record<string, unknown>)
    : {};
  const isRide = pack.type === "ride";

  // Planning packs get the interactive map view, not the download page.
  if (pack.type === "plan") {
    const doc = version?.blobUrl
      ? await fetch(version.blobUrl)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)
      : null;
    return (
      <div className="flex min-h-screen flex-col">
        <Header />
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-4 py-2.5">
          <span className="font-display text-xs font-medium uppercase tracking-[0.25em] text-gum">
            Trip plan
            {pack.visibility === "private" && " — private (only you see this)"}
          </span>
          <h1 className="font-display text-2xl font-black uppercase leading-none">
            {pack.name}
          </h1>
          <span className="text-sm text-bone-dim">
            by {pack.authorName} · v{pack.currentVersion}
            {pack.description ? ` · ${pack.description}` : ""}
          </span>
          {pack.visibility !== "private" && (
            <span className="ml-auto">
              <CopyLinkButton path={`/p/${pack.shareToken}`} />
            </span>
          )}
        </div>
        {doc ? (
          <PlanView doc={doc} token={pack.shareToken} />
        ) : (
          <p className="px-6 py-16 text-center text-bone-dim">
            Plan data missing — re-publish from Dingo Plan.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="relative min-h-screen">
      <TopoBackdrop />
      <Header />
      <main className="relative z-10 mx-auto max-w-2xl px-6 pb-20 pt-12">
        <p className="font-display text-sm font-medium uppercase tracking-[0.25em] text-gum">
          {isRide ? "Ride pack" : "Map scheme"}
          {pack.visibility === "private" && " — private (only you see this)"}
          {pack.visibility === "pending" &&
            isOwner &&
            " — pending review for the galleries (link already works)"}
        </p>
        {meta._legacyTiles === true && (
          <p className="mt-2 inline-block rounded-full border border-line px-3 py-1 text-xs uppercase tracking-wider text-bone-dim">
            legacy pack — contains embedded tiles
          </p>
        )}
        <h1 className="mt-2 font-display text-5xl font-black uppercase leading-tight">
          {pack.name}
        </h1>
        <p className="mt-2 text-bone-dim">
          by {pack.authorName} · v{pack.currentVersion} ·{" "}
          {pack.updatedAt.toISOString().slice(0, 10)}
          {version?.size
            ? ` · ${(version.size / 1024 / 1024).toFixed(1)} MB`
            : ""}
        </p>

        {version?.previewUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={version.previewUrl}
            alt={`${pack.name} preview`}
            className="mt-6 w-full rounded-lg border border-line"
          />
        )}

        {pack.description && (
          <p className="mt-5 whitespace-pre-line text-bone-dim">
            {pack.description}
          </p>
        )}

        <div className="mt-8 flex flex-wrap gap-3">
          {isRide ? (
            <a
              href={`https://nav.dingodirt.com/?dl=${encodeURIComponent(
                `https://dingodirt.com${downloadPath}`,
              )}`}
              className="rounded bg-clay px-6 py-3.5 font-display text-xl font-bold uppercase tracking-wide text-ink transition-colors hover:bg-clay-hot"
            >
              Ride it
            </a>
          ) : (
            <>
              <a
                href={`https://nav.dingodirt.com/?scheme=${encodeURIComponent(
                  `https://dingodirt.com${downloadPath}`,
                )}`}
                className="rounded bg-clay px-6 py-3.5 font-display text-xl font-bold uppercase tracking-wide text-ink transition-colors hover:bg-clay-hot"
              >
                Ride with it
              </a>
              <a
                href={`https://studio.dingodirt.com/?scheme=${encodeURIComponent(
                  `https://dingodirt.com${downloadPath}`,
                )}`}
                className="rounded border border-line px-6 py-3.5 font-display text-xl font-bold uppercase tracking-wide transition-colors hover:border-clay hover:text-clay-hot"
              >
                Remix in Studio
              </a>
            </>
          )}
          <a
            href={downloadPath}
            className="rounded border border-line px-6 py-3.5 font-display text-xl font-bold uppercase tracking-wide transition-colors hover:border-clay hover:text-clay-hot"
          >
            Download
          </a>
          {pack.visibility !== "private" && (
            <CopyLinkButton path={`/p/${pack.shareToken}`} />
          )}
        </div>

        {Object.keys(meta).length > 0 && (
          <dl className="mt-10 grid grid-cols-2 gap-x-6 gap-y-2 rounded border border-line bg-ink-2/60 p-5 text-sm sm:grid-cols-3">
            {Object.entries(meta)
              .filter(([, v]) => ["string", "number"].includes(typeof v))
              .slice(0, 9)
              .map(([k, v]) => (
                <div key={k}>
                  <dt className="uppercase tracking-wider text-bone-dim/70">
                    {k}
                  </dt>
                  <dd className="text-bone">{String(v)}</dd>
                </div>
              ))}
          </dl>
        )}

        {isRide && (
          <p className="mt-8 rounded border border-line bg-ink-2/60 px-4 py-3 text-sm text-bone-dim">
            ⚠ Routes are shared as-is by community members. Check land
            access and local rules — conditions change. Ride at your own
            risk.{" "}
            <Link href="/terms" className="underline hover:text-clay-hot">
              Terms
            </Link>
          </p>
        )}

        <div className="mt-6">
          {pack.visibility === "public" && <ReportButton token={pack.shareToken} />}
        </div>

        {isOwner ? (
          <p className="mt-6 text-sm text-bone-dim">
            Manage visibility and versions in your{" "}
            <Link href="/dashboard" className="text-clay-hot underline">
              dashboard
            </Link>
            .
          </p>
        ) : (
          !user && (
            <p className="mt-6 text-sm text-bone-dim">
              Got rides of your own?{" "}
              <Link href="/publish" className="text-clay-hot underline">
                Share your own rides →
              </Link>
            </p>
          )
        )}
      </main>
    </div>
  );
}
