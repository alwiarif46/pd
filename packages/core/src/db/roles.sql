-- Database roles for the Proposal Development Tool
-- These roles implement the security model described in 02-architecture.md section 4

-- pd_owner: Used by migrations only. Owns the tables.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pd_owner') THEN
    CREATE ROLE pd_owner WITH LOGIN PASSWORD '${PD_OWNER_PASSWORD}';
  END IF;
END
$$;

-- pd_app: Used by api and worker. Not the table owner. NOBYPASSRLS.
-- Reaches tenant tables only through row-level security.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pd_app') THEN
    CREATE ROLE pd_app WITH LOGIN PASSWORD '${PD_APP_PASSWORD}' NOBYPASSRLS;
  END IF;
END
$$;

-- pd_system: Used by SECURITY DEFINER functions for jobs with no org context.
-- NOLOGIN. Can only be called through named functions.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pd_system') THEN
    CREATE ROLE pd_system NOLOGIN;
  END IF;
END
$$;

-- Grant pd_app access to the database
GRANT CONNECT ON DATABASE pd TO pd_app;
GRANT USAGE ON SCHEMA public TO pd_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO pd_app;
GRANT INSERT ON ALL TABLES IN SCHEMA public TO pd_app;
GRANT UPDATE ON ALL TABLES IN SCHEMA public TO pd_app;
GRANT DELETE ON ALL TABLES IN SCHEMA public TO pd_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pd_app;

-- Alter tables to be owned by pd_owner
-- This will be done by Drizzle migrations
