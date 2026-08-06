import {
  boolean,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

// ---- Auth.js tables (shape required by @auth/drizzle-adapter) ----

export const users = pgTable("user", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("emailVerified", { mode: "date" }),
  image: text("image"),
});

export const accounts = pgTable(
  "account",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => [
    primaryKey({ columns: [account.provider, account.providerAccountId] }),
  ],
);

export const sessions = pgTable("session", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verificationToken",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (vt) => [primaryKey({ columns: [vt.identifier, vt.token] })],
);

// ---- dingodirt tables ----

// Elevated roles only — every signed-in user can publish. "trusted" skips
// the public-listing review queue; "admin" moderates.
export const allowlist = pgTable("allowlist", {
  email: text("email").primaryKey(),
  role: text("role").$type<"trusted" | "admin">().notNull().default("trusted"),
  displayName: text("display_name"),
  addedAt: timestamp("added_at", { mode: "date" }).notNull().defaultNow(),
});


// Nestable, dashboard-only organization (no folder-level sharing).
export const folders = pgTable("folders", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  parentId: text("parent_id"),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
});

export const packs = pgTable("packs", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  type: text("type").$type<"ride" | "scheme">().notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  // "pending" = author requested public; link works like unlisted until an
  // admin approves it into the galleries.
  visibility: text("visibility")
    .$type<"private" | "unlisted" | "pending" | "public">()
    .notNull()
    .default("private"),
  shareToken: text("share_token").notNull().unique(),
  folderId: text("folder_id").references(() => folders.id, {
    onDelete: "set null",
  }),
  currentVersion: integer("current_version").notNull().default(1),
  downloads: integer("downloads").notNull().default(0),
  authorName: text("author_name").notNull(),
  // Soft delete: retracted packs keep their row (and blobs for 30 days).
  deletedAt: timestamp("deleted_at", { mode: "date" }),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
});

export const packVersions = pgTable("pack_versions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  packId: text("pack_id")
    .notNull()
    .references(() => packs.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  blobUrl: text("blob_url").notNull(),
  previewUrl: text("preview_url"),
  size: integer("size").notNull(),
  checksum: text("checksum").notNull(),
  // Extracted from bundle.json / scheme.json at upload time.
  metadata: text("metadata"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
});

// Community reports on public packs (route through private property, etc.).
export const reports = pgTable("reports", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  packId: text("pack_id")
    .notNull()
    .references(() => packs.id, { onDelete: "cascade" }),
  reason: text("reason").notNull(),
  reporterIp: text("reporter_ip"),
  resolved: boolean("resolved").notNull().default(false),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
});
