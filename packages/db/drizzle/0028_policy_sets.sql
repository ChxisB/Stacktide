CREATE TABLE "policy_sets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"ref" text NOT NULL,
	"path" text DEFAULT '.' NOT NULL,
	"tag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_sets_org_name_key" UNIQUE("organization_id","name"),
	CONSTRAINT "policy_sets_text_check" CHECK (length("policy_sets"."name") between 1 and 63 and length("policy_sets"."source") between 3 and 2000 and length("policy_sets"."ref") between 1 and 100 and length("policy_sets"."path") between 1 and 200 and length("policy_sets"."tag") between 1 and 32)
);
--> statement-breakpoint
ALTER TABLE "run_stacks" ADD COLUMN "policy_verdict" text;--> statement-breakpoint
ALTER TABLE "run_stacks" ADD COLUMN "policy_denied" jsonb;--> statement-breakpoint
ALTER TABLE "run_stacks" ADD COLUMN "policy_warned" jsonb;--> statement-breakpoint
ALTER TABLE "run_stacks" ADD COLUMN "policy_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "policy_sets" ADD CONSTRAINT "policy_sets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "policy_sets_org_idx" ON "policy_sets" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "run_stacks" ADD CONSTRAINT "run_stacks_policy_check" CHECK (("run_stacks"."policy_verdict" is null) = ("run_stacks"."policy_at" is null)
        and ("run_stacks"."policy_verdict" is null) = ("run_stacks"."policy_denied" is null)
        and ("run_stacks"."policy_verdict" is null) = ("run_stacks"."policy_warned" is null)
        and ("run_stacks"."policy_verdict" is null or "run_stacks"."policy_verdict" in ('pass', 'warn', 'deny'))
        and coalesce(length("run_stacks"."policy_denied"::text), 0) <= 100000
        and coalesce(length("run_stacks"."policy_warned"::text), 0) <= 100000);--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): keep when editing this file.
CREATE TRIGGER policy_sets_updated BEFORE UPDATE ON policy_sets FOR EACH ROW EXECUTE FUNCTION set_updated_at();
