ALTER TABLE birthday_settings FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE birthday_texts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE TRUNCATE ON birthday_settings, birthday_texts FROM brillianda_app;--> statement-breakpoint

-- The daily birthday job (B2) finds the schools that send birthday texts through this one
-- function, owned by the platform role like the others. It returns ids and names only; the job
-- then works inside each school with withSchool, under that school's row-level security.
GRANT SELECT ON birthday_settings TO brillianda_platform;--> statement-breakpoint

-- safety: allow security-definer because the daily job must find every school that turned birthday texts on; returns the school's id, address and name only, search_path pinned
CREATE FUNCTION app_birthday_schools()
  RETURNS TABLE (school_id uuid, subdomain text, name text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT s.id, s.subdomain::text, s.name
  FROM public.schools s
  JOIN public.birthday_settings b ON b.school_id = s.id AND b.enabled
  WHERE s.status = 'active'
  ORDER BY s.created_at
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app_birthday_schools() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_birthday_schools() TO brillianda_app;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO brillianda_platform;--> statement-breakpoint
ALTER FUNCTION app_birthday_schools() OWNER TO brillianda_platform;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM brillianda_platform;
