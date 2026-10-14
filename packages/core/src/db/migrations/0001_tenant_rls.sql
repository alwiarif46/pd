-- 0001_tenant_rls: roles, grants, and row-level security for every tenant table (02 s4, 03, 07).
--
-- Run as the owner role (pd_owner), which must be able to create roles and schemas.
-- No passwords are set here. Set them out of band, for example:
--   ALTER ROLE pd_app PASSWORD '...';
--
-- Policy expression: NULLIF turns an unset or reset `app.org_id` (it reads as '' once a
-- transaction-local value has ended on that connection) into NULL, so a query outside
-- `withOrg` sees no rows instead of failing on ''::uuid.

-- Roles ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pd_app') THEN
    CREATE ROLE pd_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pd_system') THEN
    CREATE ROLE pd_system NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
--> statement-breakpoint

-- Grants --------------------------------------------------------------------
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO pd_app', current_database());
END
$$;
--> statement-breakpoint
REVOKE ALL ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO pd_app, pd_system;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pd_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pd_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pd_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO pd_app;
--> statement-breakpoint

-- Row-level security on every tenant table (the tables marked T in 03) -------
-- One policy per table, for all commands, for pd_app only. Any other role that is not a
-- superuser and has no BYPASSRLS sees no rows (FORCE applies the policies to the owner too).
DO $$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'memberships', 'invites', 'rfp_credits', 'audit_log',
    'bids', 'documents', 'upload_sessions', 'amendments', 'amendment_links', 'pages',
    'archive_objects', 'jobs', 'exports', 'ai_runs',
    'bid_facts', 'kickoff_items', 'schedule_activities', 'compliance_rows', 'outline_items',
    'personnel_requirements', 'candidates', 'resume_matches', 'reviews', 'review_assignments',
    'review_findings', 'production_items', 'orals_items', 'lessons', 'row_history'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO pd_app '
      'USING (org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid) '
      'WITH CHECK (org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)',
      tenant_table
    );
  END LOOP;
END
$$;
--> statement-breakpoint

-- Membership lookup before app.org_id is known ------------------------------
-- The api has to find a signed-in user's organizations before it can set app.org_id.
-- pd_system owns one SECURITY DEFINER function that returns only (org_id, role) for one
-- user id. pd_system may read just those memberships columns, through its own policy.
-- pd_app may execute the function but cannot become pd_system.
CREATE SCHEMA IF NOT EXISTS pd_system AUTHORIZATION pd_system;
--> statement-breakpoint
REVOKE ALL ON SCHEMA pd_system FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA pd_system TO pd_app;
--> statement-breakpoint
GRANT SELECT (org_id, user_id, role, created_at) ON public.memberships TO pd_system;
--> statement-breakpoint
CREATE POLICY system_membership_lookup ON public.memberships AS PERMISSIVE FOR SELECT TO pd_system
  USING (true);
--> statement-breakpoint
CREATE FUNCTION pd_system.user_memberships(p_user_id uuid)
  RETURNS TABLE (org_id uuid, role text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT m.org_id, m.role
  FROM public.memberships AS m
  WHERE m.user_id = p_user_id
  ORDER BY m.created_at, m.org_id
$$;
--> statement-breakpoint
ALTER FUNCTION pd_system.user_memberships(uuid) OWNER TO pd_system;
--> statement-breakpoint
REVOKE ALL ON FUNCTION pd_system.user_memberships(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION pd_system.user_memberships(uuid) TO pd_app;
