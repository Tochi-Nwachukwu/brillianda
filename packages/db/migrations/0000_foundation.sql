-- Foundation: extensions, schema privileges and the tenant function every policy uses.
-- Runs as brillianda_owner (the database owner). Roles come from scripts/bootstrap.ts.

-- citext, pg_trgm and unaccent are trusted extensions: the database owner may create them.
CREATE EXTENSION IF NOT EXISTS citext;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS unaccent;--> statement-breakpoint

-- Nobody but the owner creates objects in public. The app may only use what it is granted.
REVOKE ALL ON SCHEMA public FROM PUBLIC;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO brillianda_app, brillianda_platform;--> statement-breakpoint

-- Every table the owner creates from here on is readable/writable by the app role.
-- Exceptions (audit_log is append-only, no deletes on platform tables) are revoked per table.
ALTER DEFAULT PRIVILEGES FOR ROLE brillianda_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO brillianda_app;--> statement-breakpoint

-- The school the current transaction is scoped to, or NULL.
-- withSchool() sets app.school_id transaction-locally. Once a transaction on a pooled
-- connection has set it, later reads return '' instead of NULL; nullif() turns that back into
-- NULL so an unset school matches no rows instead of raising a cast error.
CREATE FUNCTION app_current_school_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$ SELECT nullif(current_setting('app.school_id', true), '')::uuid $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_current_school_id() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_school_id() TO brillianda_app, brillianda_platform;--> statement-breakpoint

-- unaccent() is STABLE, but index expressions need IMMUTABLE. This wrapper pins the dictionary
-- so trigram name search (students, later) can be indexed: "Ola" finds "Ọlá".
CREATE FUNCTION app_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  SET search_path = pg_catalog, public
AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_unaccent(text) TO brillianda_app;
