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
  // Microsoft is optional: it only exists so Outlook/Hotmail folk can sign in
  // without a Google account, and setting it up needs an Azure tenant. With
  // its env vars absent the provider (and its button on /signin) disappears;
  // add AUTH_MICROSOFT_ENTRA_ID_ID/_SECRET/_ISSUER later to light it up.
  providers: [
    Google,
    ...(process.env.AUTH_MICROSOFT_ENTRA_ID_ID ? [MicrosoftEntraID] : []),
  ],
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
