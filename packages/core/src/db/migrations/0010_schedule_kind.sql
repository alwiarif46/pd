-- 0010_schedule_kind
-- The schedule port (05 s3.2, PR4).
-- - schedule_activities.kind: 'milestone' | 'writing' | 'review' | 'production' | 'submission' |
--   'custom', NOT NULL, default 'custom'.
-- - schedule_activities.review_color: 'blue' | 'pink' | 'red' | 'green' | 'gold' | 'white_glove',
--   or null; only an activity of kind 'review' has one.
-- - schedule_activities.origin gains 'template' and a CHECK ('ai', 'user', 'template'; null
--   allowed, as on every source-bearing table). Nothing wrote any other value; a stray one would
--   become 'user'.
-- - bids.schedule_workdays_only: the schedule's "Workdays only" setting, NOT NULL, default true.
--   With it on, shift, scale, and templates skip weekends and US federal holidays.
-- The lists match packages/core schedule.ts (ACTIVITY_KINDS, REVIEW_COLORS, ACTIVITY_ORIGINS).
-- Backfill:
-- - origin 'template': the rows the old seed route wrote. It inserted a whole template in one
--   statement (one created_at for every row), origin 'user', no document, with fixed labels:
--   standard (Kickoff, Storyboard, Draft, Pink team, Red team, Production, Submit) or
--   color-reviews (Pink team, Red team, Gold team, Production). A bid's rows sharing one
--   created_at that are all such rows and carry exactly one of those label sets become
--   'template'. The api inserts one row per request, so a hand-added row never shares that
--   created_at. A seeded set with a renamed or deleted row no longer matches and stays 'user'.
-- - kind and review_color from phase, then label, with the rules of inferActivityKind in
--   schedule.ts (a "<color> team" or "white glove" label is a review of that color, "Submit" a
--   submission, and so on); a row neither names is 'milestone' when the AI wrote it (a date from
--   the solicitation), else 'custom'.
-- The owner sees no tenant rows while FORCE ROW LEVEL SECURITY is on (0001), so it is lifted on
-- schedule_activities for the backfill and put back, as 0004 and 0006 to 0009 do.
-- lock_timeout: as in 0007 to 0009, set here and reset at the end (the migrator runs every
-- pending migration in one transaction).
-- The columns follow schema.ts (the snapshot was written to match: drizzle-kit 0.24 cannot load
-- the ESM schema under Node 24); the backfill, the CHECKs, and lock_timeout are hand-written.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "bids" ADD COLUMN "schedule_workdays_only" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "schedule_activities" ADD COLUMN "kind" text DEFAULT 'custom' NOT NULL;
--> statement-breakpoint
ALTER TABLE "schedule_activities" ADD COLUMN "review_color" text;
--> statement-breakpoint
ALTER TABLE "schedule_activities" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE "schedule_activities" SET "origin" = 'user'
WHERE "origin" IS NOT NULL AND "origin" NOT IN ('ai', 'user', 'template');
--> statement-breakpoint
UPDATE "schedule_activities" AS a SET "origin" = 'template'
FROM (
  SELECT "bid_id", "created_at"
  FROM "schedule_activities"
  GROUP BY "bid_id", "created_at"
  HAVING bool_and("origin" IS NOT DISTINCT FROM 'user' AND "document_id" IS NULL)
    AND array_agg("label" ORDER BY "label" COLLATE "C") IN (
      ARRAY['Draft', 'Kickoff', 'Pink team', 'Production', 'Red team', 'Storyboard', 'Submit']::text[],
      ARRAY['Gold team', 'Pink team', 'Production', 'Red team']::text[]
    )
) AS seeded
WHERE a."bid_id" = seeded."bid_id" AND a."created_at" = seeded."created_at";
--> statement-breakpoint
CREATE FUNCTION pg_temp.pd_activity_kind(raw text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN n ~ '^white[ -]glove\y' THEN ARRAY['review', 'white_glove']
    WHEN n ~ '^(blue|pink|red|green|gold)[ -]team\y' THEN ARRAY['review', substring(n FROM '^(blue|pink|red|green|gold)')]
    WHEN n ~ '\yproposals? due\y|^submit|^submission\y' THEN ARRAY['submission', NULL]
    WHEN n ~ 'production|\yprint|packag' THEN ARRAY['production', NULL]
    WHEN n ~ 'kickoff|kick-off|meeting|released|questions|answers|site visit|\ydue\y' THEN ARRAY['milestone', NULL]
    WHEN n ~ 'draft|\ywrit|storyboard|outline|revis|pricing' THEN ARRAY['writing', NULL]
  END
  FROM (SELECT lower(btrim(raw)) AS n) AS normalized
$$;
--> statement-breakpoint
UPDATE "schedule_activities" AS a SET "kind" = k.v[1], "review_color" = k.v[2]
FROM (
  SELECT "id", COALESCE(
    pg_temp.pd_activity_kind("phase"),
    pg_temp.pd_activity_kind("label"),
    CASE WHEN "origin" = 'ai' THEN ARRAY['milestone', NULL] END
  ) AS v
  FROM "schedule_activities"
) AS k
WHERE a."id" = k."id" AND k.v IS NOT NULL;
--> statement-breakpoint
DROP FUNCTION pg_temp.pd_activity_kind(text);
--> statement-breakpoint
ALTER TABLE "schedule_activities" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "schedule_activities" ADD CONSTRAINT "schedule_activities_kind_check"
  CHECK ("kind" IN ('milestone', 'writing', 'review', 'production', 'submission', 'custom'));
--> statement-breakpoint
ALTER TABLE "schedule_activities" ADD CONSTRAINT "schedule_activities_review_color_check"
  CHECK ("review_color" IN ('blue', 'pink', 'red', 'green', 'gold', 'white_glove'));
--> statement-breakpoint
ALTER TABLE "schedule_activities" ADD CONSTRAINT "schedule_activities_review_color_kind_check"
  CHECK ("review_color" IS NULL OR "kind" = 'review');
--> statement-breakpoint
ALTER TABLE "schedule_activities" ADD CONSTRAINT "schedule_activities_origin_check"
  CHECK ("origin" IN ('ai', 'user', 'template'));
--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
