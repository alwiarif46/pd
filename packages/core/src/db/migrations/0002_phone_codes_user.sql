-- Ties each phone code to the account it was sent for and records when it was used, so
-- verify-phone accepts only that account's latest unused, unexpired code. Codes written before
-- this migration have no user_id and are never accepted; they expired within 10 minutes anyway.
-- phone_codes has no org_id and no row-level security; pd_app keeps its table grants.
ALTER TABLE "phone_codes" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "phone_codes" ADD COLUMN "used_at" timestamp;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "phone_codes" ADD CONSTRAINT "phone_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "phone_codes_user_id_created_at_idx" ON "phone_codes" USING btree ("user_id","created_at");