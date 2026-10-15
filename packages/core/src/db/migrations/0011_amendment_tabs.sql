-- 0011_amendment_tabs
-- Amendment step 8 (04 s3.1, PR5): the bid facts and schedule dates an amendment changes.
-- - bid_facts.fact_key: 'agency' | 'solicitation_number' | 'naics' | 'set_aside' | 'contract_type' |
--   'pop' | 'place' | 'submission_method' | 'contracting_officer' | 'other', NOT NULL, default
--   'other'. An amendment's fact on a key other than 'other' supersedes the bid's earlier active
--   facts on that key (packages/core amendment-tabs.ts); 'other' facts are only ever added.
-- - schedule_activities.date_key: 'proposal_due' | 'questions_due' | 'site_visit' | 'orals' |
--   'other', NOT NULL, default 'other', with the same rule for dates.
-- - amendments.tabs_status: 'pending' (step 8 queued after the compliance apply), 'applied', or
--   'failed' (until a retry); null for amendments that never queued step 8 (all of them before
--   this migration).
-- - Indexes on (bid_id, fact_key) and (bid_id, date_key): step 8 reads a bid's active rows by key.
-- The lists match packages/core amendment-tabs.ts (FACT_KEYS, DATE_KEYS, TABS_STATUSES).
-- Backfill: fact_key from the field, lower-cased with everything but letters and digits removed,
-- with the spellings of FACT_KEY_SPELLINGS in amendment-tabs.ts (factKeyOf); anything else stays
-- 'other'. date_key is not backfilled: the dates step wrote no day before this migration, and only
-- a dated row can replace another, so every existing date row stays 'other'.
-- The owner sees no tenant rows while FORCE ROW LEVEL SECURITY is on (0001), so it is lifted on
-- bid_facts for the backfill and put back, as 0004 and 0006 to 0010 do.
-- lock_timeout: as in 0007 to 0010, set here and reset at the end (the migrator runs every
-- pending migration in one transaction).
-- The columns and indexes follow schema.ts (the snapshot was written to match: drizzle-kit 0.24
-- cannot load the ESM schema under Node 24); the backfill, the CHECKs, and lock_timeout are
-- hand-written.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "bid_facts" ADD COLUMN "fact_key" text DEFAULT 'other' NOT NULL;
--> statement-breakpoint
ALTER TABLE "schedule_activities" ADD COLUMN "date_key" text DEFAULT 'other' NOT NULL;
--> statement-breakpoint
ALTER TABLE "amendments" ADD COLUMN "tabs_status" text;
--> statement-breakpoint
ALTER TABLE "bid_facts" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE "bid_facts" AS f SET "fact_key" = k.v
FROM (
  SELECT "id", CASE regexp_replace(lower("field"), '[^a-z0-9]', '', 'g')
    WHEN 'agency' THEN 'agency'
    WHEN 'issuingagency' THEN 'agency'
    WHEN 'contractingagency' THEN 'agency'
    WHEN 'solicitationnumber' THEN 'solicitation_number'
    WHEN 'solicitationno' THEN 'solicitation_number'
    WHEN 'solicitation' THEN 'solicitation_number'
    WHEN 'naics' THEN 'naics'
    WHEN 'naicscode' THEN 'naics'
    WHEN 'setaside' THEN 'set_aside'
    WHEN 'setasidetype' THEN 'set_aside'
    WHEN 'contracttype' THEN 'contract_type'
    WHEN 'pop' THEN 'pop'
    WHEN 'periodofperformance' THEN 'pop'
    WHEN 'place' THEN 'place'
    WHEN 'placeofperformance' THEN 'place'
    WHEN 'submissionmethod' THEN 'submission_method'
    WHEN 'contractingofficer' THEN 'contracting_officer'
    WHEN 'co' THEN 'contracting_officer'
  END AS v
  FROM "bid_facts"
) AS k
WHERE f."id" = k."id" AND k.v IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "bid_facts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bid_facts" ADD CONSTRAINT "bid_facts_fact_key_check"
  CHECK ("fact_key" IN ('agency', 'solicitation_number', 'naics', 'set_aside', 'contract_type', 'pop', 'place',
    'submission_method', 'contracting_officer', 'other'));
--> statement-breakpoint
ALTER TABLE "schedule_activities" ADD CONSTRAINT "schedule_activities_date_key_check"
  CHECK ("date_key" IN ('proposal_due', 'questions_due', 'site_visit', 'orals', 'other'));
--> statement-breakpoint
ALTER TABLE "amendments" ADD CONSTRAINT "amendments_tabs_status_check"
  CHECK ("tabs_status" IN ('pending', 'applied', 'failed'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bid_facts_bid_id_fact_key_idx" ON "bid_facts" USING btree ("bid_id","fact_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedule_activities_bid_id_date_key_idx" ON "schedule_activities" USING btree ("bid_id","date_key");
--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
