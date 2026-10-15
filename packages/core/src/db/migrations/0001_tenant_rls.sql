-- 0001_tenant_rls: roles, grants, and row-level security for every tenant table (02 s4, 03, 07).
--
-- Run as the owner role (pd_owner). It does not need to be a superuser, but it must:
--   - own the database (it revokes PUBLIC on schema public, which belongs to the database
--     owner from Postgres 15, and grants CONNECT on the database);
--   - have CREATEROLE, or find pd_app and pd_system already created with the attributes below.
-- From Postgres 16 a CREATEROLE role gets ADMIN on the roles it creates; this migration then
-- grants itself SET (not INHERIT) on pd_system, which CREATE SCHEMA ... AUTHORIZATION and the
-- SET ROLE pd_system below need. Notes on that grant:
--   - The migrator keeps SET on pd_system afterwards (it can become pd_system, and so read
--     every organization's memberships through pd_system's policy). Revoke it by hand after
--     migrating if that matters: REVOKE pd_system FROM <migrator>; re-grant before a later
--     migration touches pd_system objects.
--   - Before Postgres 16 there is no SET/INHERIT split: the plain GRANT also gives INHERIT,
--     so the migrator reads all memberships without SET ROLE. This stack runs Postgres 16;
--     the older branch is there only so the migration does not fail.
--   - If pd_system already exists and another role created it, a non-superuser migrator has
--     no ADMIN on it and cannot grant itself SET: a superuser must run
--     GRANT pd_system TO <migrator> WITH INHERIT FALSE, SET TRUE before migrating.
--
-- No passwords are set here. Set them out of band, for example:
--   ALTER ROLE pd_app PASSWORD '...';
--
-- Later migrations: FORCE ROW LEVEL SECURITY applies the policies to the table owner too, and
-- no policy names the owner, so the migrator reads and writes zero tenant rows. A data backfill
-- must run per organization with app.org_id set and a policy that covers the role it runs as
-- (or as pd_app), not as a plain UPDATE from the owner.
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
  -- The migrator must be able to SET ROLE pd_system to hand it the schema and function below.
  -- A superuser already can. Postgres 16 separates SET from INHERIT, so the migrator does not
  -- pick up pd_system's read access to memberships; before 16 a plain grant is the only form.
  IF current_setting('server_version_num')::int >= 160000 THEN
    IF NOT pg_has_role(current_user, 'pd_system', 'SET') THEN
      EXECUTE format('GRANT pd_system TO %I WITH INHERIT FALSE, SET TRUE', current_user);
    END IF;
  ELSIF NOT pg_has_role(current_user, 'pd_system', 'MEMBER') THEN
    EXECUTE format('GRANT pd_system TO %I', current_user);
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

-- Policies from the old hand-applied rls.sql, if this database was set up with it --
DO $$
DECLARE
  old_table text;
  old_policy text;
BEGIN
  FOREACH old_table IN ARRAY ARRAY['memberships', 'bids', 'documents'] LOOP
    FOREACH old_policy IN ARRAY ARRAY['tenant_select', 'tenant_insert', 'tenant_update', 'tenant_delete'] LOOP
      IF to_regclass(format('public.%I', old_table)) IS NOT NULL THEN
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', old_policy, old_table);
      END IF;
    END LOOP;
  END LOOP;
END
$$;
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

-- organizations: keyed by its own id rather than org_id ------------------------
-- pd_app sees and changes only the organization named by app.org_id. Creating one works
-- because the api sets app.org_id to the new id before the insert (POST /api/org).
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.organizations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.organizations AS PERMISSIVE FOR ALL TO pd_app
  USING (id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint

-- Membership lookup before app.org_id is known ------------------------------
-- The api has to find a signed-in user's organizations before it can set app.org_id.
-- pd_system owns one SECURITY DEFINER function that returns only (org_id, role) for one
-- user id. pd_system may read just those memberships columns, through its own policy.
-- pd_app may execute the function but cannot become pd_system.
-- The migrator owns memberships, so it grants pd_system's access and policy itself. The
-- schema contents are created as pd_system (SET ROLE, which the role block made possible),
-- so a migrator without INHERIT on pd_system needs no rights in that schema.
CREATE SCHEMA IF NOT EXISTS pd_system AUTHORIZATION pd_system;
--> statement-breakpoint
GRANT SELECT (org_id, user_id, role, created_at) ON public.memberships TO pd_system;
--> statement-breakpoint
CREATE POLICY system_membership_lookup ON public.memberships AS PERMISSIVE FOR SELECT TO pd_system
  USING (true);
--> statement-breakpoint
SET ROLE pd_system;
--> statement-breakpoint
REVOKE ALL ON SCHEMA pd_system FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA pd_system TO pd_app;
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
REVOKE ALL ON FUNCTION pd_system.user_memberships(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION pd_system.user_memberships(uuid) TO pd_app;
--> statement-breakpoint
RESET ROLE;
