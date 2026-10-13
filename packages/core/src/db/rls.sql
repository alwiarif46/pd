-- Row-Level Security Policies
-- These policies enforce multi-tenancy as described in 02-architecture.md section 4

-- Enable RLS on all tenant tables (tables with org_id)
-- FORCE ROW LEVEL SECURITY ensures policies apply even to the table owner

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;

ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites FORCE ROW LEVEL SECURITY;

ALTER TABLE rfp_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfp_credits FORCE ROW LEVEL SECURITY;

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

ALTER TABLE bids ENABLE ROW LEVEL SECURITY;
ALTER TABLE bids FORCE ROW LEVEL SECURITY;

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;

ALTER TABLE upload_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE upload_sessions FORCE ROW LEVEL SECURITY;

ALTER TABLE amendments ENABLE ROW LEVEL SECURITY;
ALTER TABLE amendments FORCE ROW LEVEL SECURITY;

ALTER TABLE amendment_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE amendment_links FORCE ROW LEVEL SECURITY;

ALTER TABLE pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE pages FORCE ROW LEVEL SECURITY;

ALTER TABLE archive_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive_objects FORCE ROW LEVEL SECURITY;

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;

ALTER TABLE exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE exports FORCE ROW LEVEL SECURITY;

ALTER TABLE bid_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bid_facts FORCE ROW LEVEL SECURITY;

ALTER TABLE kickoff_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE kickoff_items FORCE ROW LEVEL SECURITY;

ALTER TABLE schedule_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_activities FORCE ROW LEVEL SECURITY;

ALTER TABLE compliance_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_rows FORCE ROW LEVEL SECURITY;

ALTER TABLE outline_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE outline_items FORCE ROW LEVEL SECURITY;

ALTER TABLE personnel_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE personnel_requirements FORCE ROW LEVEL SECURITY;

ALTER TABLE candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidates FORCE ROW LEVEL SECURITY;

ALTER TABLE resume_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE resume_matches FORCE ROW LEVEL SECURITY;

ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews FORCE ROW LEVEL SECURITY;

ALTER TABLE review_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_assignments FORCE ROW LEVEL SECURITY;

ALTER TABLE production_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_items FORCE ROW LEVEL SECURITY;

ALTER TABLE orals_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE orals_items FORCE ROW LEVEL SECURITY;

ALTER TABLE lessons ENABLE ROW LEVEL SECURITY;
ALTER TABLE lessons FORCE ROW LEVEL SECURITY;

ALTER TABLE row_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE row_history FORCE ROW LEVEL SECURITY;

-- ============================================================================
-- RLS Policies
-- Each policy compares org_id with current_setting('app.org_id')
-- A transaction with no setting sees no rows
-- ============================================================================

-- Generic policy function (create one per table type)
-- SELECT policy: can only see rows where org_id matches current_setting
CREATE POLICY tenant_select ON memberships
  FOR SELECT
  TO pd_app
  USING (org_id = current_setting('app.org_id', true)::uuid);

CREATE POLICY tenant_insert ON memberships
  FOR INSERT
  TO pd_app
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);

CREATE POLICY tenant_update ON memberships
  FOR UPDATE
  TO pd_app
  USING (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);

CREATE POLICY tenant_delete ON memberships
  FOR DELETE
  TO pd_app
  USING (org_id = current_setting('app.org_id', true)::uuid);

-- Repeat similar policies for all other tenant tables
-- For brevity, showing pattern for a few key tables

-- bids
CREATE POLICY tenant_select ON bids
  FOR SELECT TO pd_app
  USING (org_id = current_setting('app.org_id', true)::uuid);

CREATE POLICY tenant_insert ON bids
  FOR INSERT TO pd_app
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);

CREATE POLICY tenant_update ON bids
  FOR UPDATE TO pd_app
  USING (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);

CREATE POLICY tenant_delete ON bids
  FOR DELETE TO pd_app
  USING (org_id = current_setting('app.org_id', true)::uuid);

-- documents
CREATE POLICY tenant_select ON documents
  FOR SELECT TO pd_app
  USING (org_id = current_setting('app.org_id', true)::uuid);

CREATE POLICY tenant_insert ON documents
  FOR INSERT TO pd_app
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);

CREATE POLICY tenant_update ON documents
  FOR UPDATE TO pd_app
  USING (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);

CREATE POLICY tenant_delete ON documents
  FOR DELETE TO pd_app
  USING (org_id = current_setting('app.org_id', true)::uuid);

-- Note: All other tenant tables need similar policies
-- This will be expanded in the full migration
