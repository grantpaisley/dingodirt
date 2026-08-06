import Link from "next/link";
import { redirect } from "next/navigation";
import TopoBackdrop from "@/components/TopoBackdrop";
import PublishForm from "@/components/PublishForm";
import { currentUser } from "@/lib/membership";

export const metadata = { title: "Publish a pack — dingodirt" };

export default async function PublishPage() {
  const user = await currentUser();
  if (!user) redirect("/signin");

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center px-6 py-16">
      <TopoBackdrop />
      <div className="relative z-10 w-full max-w-md">
        <Link
          href="/"
          className="font-display text-2xl font-black uppercase tracking-wide"
        >
          dingo<span className="text-clay">dirt</span>
        </Link>
        <h1 className="mt-6 font-display text-4xl font-bold uppercase">
          Publish a pack
        </h1>
        <p className="mt-2 text-sm text-bone-dim">
          Drop a <code>.dingonav</code> ride or a <code>.dingoscheme</code>{" "}
          scheme. It starts <strong className="text-bone">private</strong> —
          share it from your dashboard when you&apos;re ready. Re-uploading a
          pack with the same name bumps its version and keeps the same link.
          Public listings get a quick review before they appear in the
          galleries.
        </p>
        <div className="mt-8">
          <PublishForm />
        </div>
        <p className="mt-6 text-sm text-bone-dim">
          <Link href="/dashboard" className="text-clay-hot underline">
            → My packs
          </Link>
        </p>
      </div>
    </main>
  );
}
