import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq, isNull } from "drizzle-orm";
import Header from "@/components/Header";
import TopoBackdrop from "@/components/TopoBackdrop";
import PackRow from "@/components/PackRow";
import ApiTokensCard from "@/components/ApiTokensCard";
import ServiceDown from "@/components/ServiceDown";
import { db } from "@/db";
import { packs, folders } from "@/db/schema";
import { currentUser } from "@/lib/membership";
import { reportOutage } from "@/lib/alert";

export const metadata = { title: "My packs — dingodirt" };
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  let user;
  try {
    user = await currentUser();
  } catch (err) {
    await reportOutage("/dashboard", err);
    return <ServiceDown retry="/dashboard" />;
  }
  if (!user) redirect("/signin");

  let rows: (typeof packs.$inferSelect)[] = [];
  let myFolders: (typeof folders.$inferSelect)[] = [];
  try {
    [rows, myFolders] = await Promise.all([
      db
        .select()
        .from(packs)
        .where(and(eq(packs.ownerId, user.id), isNull(packs.deletedAt)))
        .orderBy(desc(packs.updatedAt)),
      db.select().from(folders).where(eq(folders.ownerId, user.id)),
    ]);
  } catch {}

  const folderName = (id: string | null) =>
    myFolders.find((f) => f.id === id)?.name ?? null;

  return (
    <div className="relative min-h-screen">
      <TopoBackdrop />
      <Header />
      <main className="relative z-10 mx-auto max-w-5xl px-6 pb-20 pt-12 sm:px-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-5xl font-black uppercase">
              My packs
            </h1>
            <p className="mt-2 text-bone-dim">
              Private → link → public (public listings get a quick review).
              Download counts update as mates grab them.
            </p>
          </div>
          <Link
            href="/publish"
            className="rounded bg-clay px-5 py-3 font-display text-lg font-bold uppercase tracking-wide text-ink transition-colors hover:bg-clay-hot"
          >
            + Publish
          </Link>
        </div>

        {rows.length === 0 ? (
          <div className="mt-12 rounded-lg border border-line bg-ink-2/60 p-10 text-center">
            <p className="font-display text-2xl font-bold uppercase text-bone-dim">
              No packs yet
            </p>
            <p className="mt-2 text-sm text-bone-dim">
              Publish your first ride or scheme and it&apos;ll land here.
            </p>
          </div>
        ) : (
          <div className="mt-8 flex flex-col gap-3">
            {rows.map((p) => (
              <PackRow
                key={p.id}
                pack={{
                  id: p.id,
                  name: p.name,
                  type: p.type,
                  visibility: p.visibility,
                  shareToken: p.shareToken,
                  version: p.currentVersion,
                  downloads: p.downloads,
                  folder: folderName(p.folderId),
                  updatedAt: p.updatedAt.toISOString().slice(0, 10),
                }}
              />
            ))}
          </div>
        )}

        <ApiTokensCard />
      </main>
    </div>
  );
}
