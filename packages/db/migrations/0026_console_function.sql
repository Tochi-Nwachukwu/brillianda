-- The team console (C1) reads counts across schools through this one function, owned by the
-- platform role like the others in 0002. It returns counts, contacts and setup flags per school,
-- never a student's own record. The API calls it only for a signed-in team member.

GRANT SELECT ON users, students, class_arms, class_levels, school_subjects, class_level_subjects, academic_sessions, invitations TO brillianda_platform;--> statement-breakpoint

-- safety: allow security-definer because the team console must count across every school; returns counts, the owner's name and email and setup flags only, search_path pinned
CREATE FUNCTION app_console_schools()
  RETURNS TABLE (
    school_id uuid,
    subdomain text,
    name text,
    status school_status,
    created_at timestamptz,
    state text,
    phone text,
    levels_offered text[],
    owner_name text,
    owner_email text,
    students bigint,
    classes bigint,
    subjects bigint,
    admins bigint,
    teachers bigint,
    parents bigint,
    calendar_done boolean,
    classes_done boolean,
    arms_done boolean,
    subjects_done boolean,
    students_done boolean,
    admins_done boolean,
    branding_done boolean
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT
    s.id, s.subdomain::text, s.name, s.status, s.created_at, s.state, s.phone, s.levels_offered,
    o.full_name, o.email::text,
    (SELECT count(*) FROM public.students x WHERE x.school_id = s.id AND x.deleted_at IS NULL AND x.status = 'active'),
    (SELECT count(*) FROM public.class_arms x WHERE x.school_id = s.id AND x.archived_at IS NULL),
    (SELECT count(*) FROM public.school_subjects x WHERE x.school_id = s.id),
    (SELECT count(*) FROM public.school_members x WHERE x.school_id = s.id AND x.status = 'active' AND x.role::text IN ('owner', 'admin')),
    (SELECT count(*) FROM public.school_members x WHERE x.school_id = s.id AND x.status = 'active' AND x.role::text = 'teacher'),
    (SELECT count(*) FROM public.school_members x WHERE x.school_id = s.id AND x.status = 'active' AND x.role::text = 'parent'),
    EXISTS (SELECT 1 FROM public.academic_sessions x WHERE x.school_id = s.id AND x.is_current AND x.confirmed_at IS NOT NULL),
    EXISTS (SELECT 1 FROM public.class_levels x WHERE x.school_id = s.id),
    EXISTS (SELECT 1 FROM public.class_arms x WHERE x.school_id = s.id),
    EXISTS (SELECT 1 FROM public.class_level_subjects x WHERE x.school_id = s.id),
    EXISTS (SELECT 1 FROM public.students x WHERE x.school_id = s.id AND x.deleted_at IS NULL),
    (SELECT count(*) FROM public.school_members x WHERE x.school_id = s.id AND x.status = 'active' AND x.role::text IN ('owner', 'admin')) > 1
      OR EXISTS (SELECT 1 FROM public.invitations x WHERE x.school_id = s.id AND x.role::text = 'admin'),
    coalesce(s.settings->>'brandingSaved', '') = 'true' OR s.brand_color IS NOT NULL OR s.logo_key IS NOT NULL
  FROM public.schools s
  LEFT JOIN public.users o ON o.id = s.owner_user_id
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app_console_schools() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_console_schools() TO brillianda_app;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO brillianda_platform;--> statement-breakpoint
ALTER FUNCTION app_console_schools() OWNER TO brillianda_platform;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM brillianda_platform;--> statement-breakpoint

-- Team sign-ins and the team log are the API's to manage; nothing is wiped wholesale.
REVOKE TRUNCATE ON team_members, team_sessions, team_log FROM brillianda_app;--> statement-breakpoint
REVOKE UPDATE, DELETE ON team_log FROM brillianda_app;
