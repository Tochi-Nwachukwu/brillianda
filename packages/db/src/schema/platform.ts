/**
 * Platform tables: not owned by any one school, so no school_id and no tenant policy.
 * The API reads them directly (e.g. school lookup by subdomain, user by email).
 */
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { citext, createdAt, id, updatedAt } from "./columns.js";

export const userStatus = pgEnum("user_status", ["active", "disabled"]);

export const users = pgTable(
  "users",
  {
    id: id(),
    email: citext().notNull().unique(),
    emailVerifiedAt: timestamp({ withTimezone: true }),
    /** Argon2id PHC string. Null only for accounts that have never set a password (invite not yet accepted). */
    passwordHash: text(),
    fullName: text().notNull(),
    phone: text(),
    status: userStatus().notNull().default("active"),
    lastLoginAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check("users_email_shape", sql`${t.email} ~ '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'`)],
);

export const schoolStatus = pgEnum("school_status", ["active", "suspended", "archived"]);

export const schools = pgTable(
  "schools",
  {
    id: id(),
    name: text().notNull(),
    /** citext + unique: two people racing for one name cannot both get it. */
    subdomain: citext().notNull().unique(),
    status: schoolStatus().notNull().default("active"),
    ownerUserId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    levelsOffered: text().array().notNull().default(sql`'{}'::text[]`),
    state: text(),
    phone: text(),
    logoKey: text(),
    brandColor: text(),
    settings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Defence in depth: the same rules packages/core enforces.
    check(
      "schools_subdomain_shape",
      sql`${t.subdomain}::text ~ '^[a-z][a-z0-9-]{1,28}[a-z0-9]$' AND ${t.subdomain}::text !~ '--'`,
    ),
    check("schools_brand_color_hex", sql`${t.brandColor} IS NULL OR ${t.brandColor} ~ '^#[0-9a-fA-F]{6}$'`),
  ],
);

export const verificationPurpose = pgEnum("verification_purpose", [
  "email_verification",
  "password_reset",
  "magic_link",
  "handover",
  "email_change",
]);

/**
 * One table for every short-lived secret: 6-digit email codes, magic links, reset links,
 * the 60-second signup handover token. Only an HMAC of the secret is stored.
 */
export const verificationTokens = pgTable(
  "verification_tokens",
  {
    id: id(),
    purpose: verificationPurpose().notNull(),
    /** Usually the email address the secret was sent to. */
    identifier: citext().notNull(),
    userId: uuid().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text().notNull().unique(),
    /** Purpose-specific data, e.g. { schoolId } for a handover. Never secrets. */
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(5),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    consumedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("verification_tokens_open_idx")
      .on(t.purpose, t.identifier, t.createdAt)
      .where(sql`${t.consumedAt} IS NULL`),
    index("verification_tokens_expires_idx").on(t.expiresAt),
  ],
);
