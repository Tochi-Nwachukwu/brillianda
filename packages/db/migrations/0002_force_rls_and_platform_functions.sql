-- FORCE row-level security on every school table, tighten grants, and add the only
-- functions that may read across schools. drizzle-kit cannot express FORCE, so it lives here.
-- A new school table must be added to the FORCE list in its own migration;
-- test/rls-coverage.test.ts fails CI if one is missed.

ALTER TABLE school_members FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- audit_log is append-only for the app.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM brillianda_app;--> statement-breakpoint
-- Schools and users are archived/disabled, never deleted by the app.
REVOKE DELETE, TRUNCATE ON schools, users FROM brillianda_app;--> statement-breakpoint
REVOKE TRUNCATE ON school_members, sessions, verification_tokens FROM brillianda_app;--> statement-breakpoint

-- The platform role reads only what the functions below need.
GRANT SELECT ON schools, school_members, sessions TO brillianda_platform;--> statement-breakpoint
GRANT DELETE ON sessions TO brillianda_platform;--> statement-breakpoint

-- Login school picker / Find my school: names and subdomains of a user's ACTIVE schools only.
CREATE FUNCTION app_user_schools(p_user_id uuid)
  RETURNS TABLE (school_id uuid, name text, subdomain text, role member_role)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT s.id, s.name, s.subdomain::text, m.role
  FROM public.school_members m
  JOIN public.schools s ON s.id = m.school_id
  WHERE m.user_id = p_user_id
    AND m.status = 'active'
    AND s.status = 'active'
  ORDER BY s.name
$$;--> statement-breakpoint

-- Sign a user out of every school (password change, account disabled).
CREATE FUNCTION app_revoke_user_sessions(p_user_id uuid, p_except_session_id uuid DEFAULT NULL)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  revoked integer;
BEGIN
  DELETE FROM public.sessions
  WHERE user_id = p_user_id
    AND (p_except_session_id IS NULL OR id <> p_except_session_id);
  GET DIAGNOSTICS revoked = ROW_COUNT;
  RETURN revoked;
END
$$;--> statement-breakpoint

-- Grants first: once ownership moves, only the platform role could change them.
REVOKE ALL ON FUNCTION app_user_schools(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_revoke_user_sessions(uuid, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_user_schools(uuid) TO brillianda_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_revoke_user_sessions(uuid, uuid) TO brillianda_app;--> statement-breakpoint

-- Hand the functions to the NOLOGIN platform role. ALTER ... OWNER needs the new owner to
-- have CREATE on the schema, so grant it only for these statements.
GRANT CREATE ON SCHEMA public TO brillianda_platform;--> statement-breakpoint
ALTER FUNCTION app_user_schools(uuid) OWNER TO brillianda_platform;--> statement-breakpoint
ALTER FUNCTION app_revoke_user_sessions(uuid, uuid) OWNER TO brillianda_platform;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM brillianda_platform;
