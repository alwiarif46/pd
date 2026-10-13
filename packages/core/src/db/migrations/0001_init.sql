-- Migration 0001: Initial schema with roles and RLS
-- This migration creates all tables and sets up the security model

-- First, create the roles
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pd_owner') THEN
    CREATE ROLE pd_owner WITH LOGIN PASSWORD '${PD_OWNER_PASSWORD}';
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pd_app') THEN
    CREATE ROLE pd_app WITH LOGIN PASSWORD '${PD_APP_PASSWORD}' NOBYPASSRLS;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pd_system') THEN
    CREATE ROLE pd_system NOLOGIN;
  END IF;
END
$$;

-- Revoke public schema access
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO pd_app;

-- Tables will be created by Drizzle and owned by pd_owner
-- After migration, run: ALTER TABLE table_name OWNER TO pd_owner;

-- Grant permissions to pd_app
GRANT CONNECT ON DATABASE pd TO pd_app;
GRANT USAGE ON SCHEMA public TO pd_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pd_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pd_app;

-- Alter future tables to have these grants automatically
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pd_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO pd_app;
