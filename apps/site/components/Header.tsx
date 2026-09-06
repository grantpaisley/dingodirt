import Link from "next/link";
import { signOut } from "@/auth";
import { displayUser } from "@/lib/membership";

const GITHUB_ORG_URL = "https://github.com/dingodirt";

export default async function Header() {
  // displayUser, not currentUser: the header renders on the outage page, so
  // it must never be the thing that takes the page down.
  const user = await displayUser();

  return (
    <header className="relative z-10 flex items-center justify-between px-6 py-5 sm:px-10">
      <Link
        href="/"
        className="font-display text-2xl font-black uppercase tracking-wide"
      >
        dingo<span className="text-clay">dirt</span>
      </Link>
      <nav className="flex items-center gap-4 text-sm font-medium sm:gap-5">
        <Link href="/rides" className="transition-colors hover:text-clay-hot">
          Rides
        </Link>
        <Link href="/schemes" className="transition-colors hover:text-clay-hot">
          Schemes
        </Link>
        <a
          href={GITHUB_ORG_URL}
          className="hidden transition-colors hover:text-clay-hot sm:inline"
        >
          GitHub
        </a>
        {user && (
          <Link
            href="/dashboard"
            className="transition-colors hover:text-clay-hot"
          >
            My packs
          </Link>
        )}
        {user?.role === "admin" && (
          <Link
            href="/admin"
            className="text-gum transition-colors hover:text-clay-hot"
          >
            Admin
          </Link>
        )}
        {user ? (
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/" });
            }}
            className="flex items-center gap-3"
          >
            <span className="hidden text-bone-dim sm:inline">{user.name}</span>
            <button
              type="submit"
              className="rounded border border-line px-3 py-1.5 transition-colors hover:border-clay hover:text-clay-hot"
            >
              Sign out
            </button>
          </form>
        ) : (
          <Link
            href="/signin"
            className="rounded border border-line px-3 py-1.5 transition-colors hover:border-clay hover:text-clay-hot"
          >
            Sign in
          </Link>
        )}
      </nav>
    </header>
  );
}
