import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

// The placeholder keeps builds working without env; queries fail loudly at
// runtime if DATABASE_URL is genuinely missing.
const sql = neon(
  process.env.DATABASE_URL ??
    "postgresql://placeholder:placeholder@placeholder.invalid/placeholder",
);

export const db = drizzle(sql, { schema });
