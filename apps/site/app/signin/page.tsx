import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import TopoBackdrop from "@/components/TopoBackdrop";

export const metadata = { title: "Sign in — dingodirt" };

export default async function SignInPage() {
  const session = await auth();
  if (session?.user) redirect("/");

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center px-6">
      <TopoBackdrop />
      <div className="relative z-10 w-full max-w-sm">
        <Link
          href="/"
          className="font-display text-2xl font-black uppercase tracking-wide"
        >
          dingo<span className="text-clay">dirt</span>
        </Link>
        <h1 className="mt-6 font-display text-4xl font-bold uppercase">
          Sign in
        </h1>
        <p className="mt-2 text-sm text-bone-dim">
          For pack authors. Riding a mate&apos;s link? You don&apos;t need an
          account — just tap it.
        </p>
        <div className="mt-8 flex flex-col gap-3">
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: "/" });
            }}
          >
            <button
              type="submit"
              className="w-full rounded border border-line bg-ink-2 px-4 py-3 font-medium transition-colors hover:border-clay hover:text-clay-hot"
            >
              Continue with Google
            </button>
          </form>
          <form
            action={async () => {
              "use server";
              await signIn("microsoft-entra-id", { redirectTo: "/" });
            }}
          >
            <button
              type="submit"
              className="w-full rounded border border-line bg-ink-2 px-4 py-3 font-medium transition-colors hover:border-clay hover:text-clay-hot"
            >
              Continue with Microsoft
            </button>
          </form>
        </div>
        <p className="mt-6 text-sm text-bone-dim">
          Signing in just gives you a place to publish —{" "}
          <Link href="/get-involved" className="text-clay-hot underline">
            more ways to get involved
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
