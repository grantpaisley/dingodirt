import Link from "next/link";
import { and, desc, eq, isNull } from "drizzle-orm";
import Header from "@/components/Header";
import TopoBackdrop from "@/components/TopoBackdrop";
import { db } from "@/db";
import { packs, packVersions } from "@/db/schema";

// Shared server component behind /rides and /schemes.
export default async function GalleryPage({
  type,
}: {
  type: "ride" | "scheme";
}) {
  let rows: {
    name: string;
    slug: string;
    author: string;
    updatedAt: Date;
    version: number;
    id: string;
  }[] = [];
  try {
    rows = await db
      .select({
        name: packs.name,
        slug: packs.slug,
        author: packs.authorName,
        updatedAt: packs.updatedAt,
        version: packs.currentVersion,
        id: packs.id,
      })
      .from(packs)
      .where(
        and(
          eq(packs.type, type),
          eq(packs.visibility, "public"),
          isNull(packs.deletedAt),
        ),
      )
      .orderBy(desc(packs.updatedAt))
      .limit(100);
  } catch {
    // DB not configured — render the empty state.
  }

  const previews = new Map<string, string>();
  if (rows.length > 0) {
    try {
      const versions = await db
        .select({
          packId: packVersions.packId,
          version: packVersions.version,
          previewUrl: packVersions.previewUrl,
        })
        .from(packVersions);
      for (const row of rows) {
        const v = versions.find(
          (x) => x.packId === row.id && x.version === row.version,
        );
        if (v?.previewUrl) previews.set(row.id, v.previewUrl);
      }
    } catch {}
  }

  const isRide = type === "ride";

  return (
    <div className="relative min-h-screen">
      <TopoBackdrop />
      <Header />
      <main className="relative z-10 mx-auto max-w-5xl px-6 pb-20 pt-12 sm:px-10">
        <h1 className="font-display text-5xl font-black uppercase">
          {isRide ? "Rides" : "Schemes"}
        </h1>
        <p className="mt-2 max-w-xl text-bone-dim">
          {isRide
            ? "Public ride packs from the crew — tap one and Nav takes it from there."
            : "Community map schemes — ride with them or remix them in Studio."}
        </p>

        {rows.length === 0 ? (
          <div className="mt-12 rounded-lg border border-line bg-ink-2/60 p-10 text-center">
            <p className="font-display text-2xl font-bold uppercase text-bone-dim">
              Nothing public yet
            </p>
            <p className="mx-auto mt-2 max-w-sm text-sm text-bone-dim">
              {isRide
                ? "The first public ride pack will show up here. Members: publish one and flip it to public."
                : "The first community scheme will show up here once Studio ships."}
            </p>
          </div>
        ) : (
          <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((p) => (
              <Link
                key={p.slug}
                href={`/p/${p.slug}`}
                className="group overflow-hidden rounded-lg border border-line bg-ink-2/80 transition-all hover:-translate-y-1 hover:border-clay"
              >
                {previews.get(p.id) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={previews.get(p.id)}
                    alt=""
                    className="aspect-[16/9] w-full object-cover"
                  />
                ) : (
                  <div className="flex aspect-[16/9] w-full items-center justify-center bg-ink-3 font-display text-3xl font-black uppercase text-line">
                    {isRide ? "Ride" : "Scheme"}
                  </div>
                )}
                <div className="p-4">
                  <h2 className="font-display text-2xl font-bold uppercase group-hover:text-clay-hot">
                    {p.name}
                  </h2>
                  <p className="mt-0.5 text-sm text-bone-dim">
                    {p.author} · v{p.version} ·{" "}
                    {p.updatedAt.toISOString().slice(0, 10)}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
