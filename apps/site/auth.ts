import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "@/db";
import {
  users,
  accounts,
  sessions,
  verificationTokens,
} from "@/db/schema";

// In production COOKIE_DOMAIN=.dingodirt.com shares the session with plan.
const cookieDomain = process.env.COOKIE_DOMAIN;

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  providers: [Google, MicrosoftEntraID],
  trustHost: true,
  ...(cookieDomain
    ? {
        cookies: {
          sessionToken: {
            name: "__Secure-authjs.session-token",
            options: {
              domain: cookieDomain,
              httpOnly: true,
              sameSite: "lax",
              path: "/",
              secure: true,
            },
          },
        },
      }
    : {}),
});
