CREATE TABLE "cost_limits" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"tag" text,
	"max_monthly_delta" double precision NOT NULL,
	"warn_at" double precision,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_limits_check" CHECK (("cost_limits"."tag" is null or "cost_limits"."tag" ~ '^[a-z0-9][a-z0-9._-]{0,31}$')
        and "cost_limits"."max_monthly_delta" between 0 and 1e12
        and ("cost_limits"."warn_at" is null or "cost_limits"."warn_at" between 0 and "cost_limits"."max_monthly_delta")
        and "cost_limits"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "cost_limits" ADD CONSTRAINT "cost_limits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cost_limits_org_scope_key" ON "cost_limits" USING btree ("organization_id",coalesce("tag", ''));--> statement-breakpoint
CREATE INDEX "cost_limits_org_idx" ON "cost_limits" USING btree ("organization_id","id");--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): keep when editing this file.
CREATE TRIGGER cost_limits_updated BEFORE UPDATE ON cost_limits FOR EACH ROW EXECUTE FUNCTION set_updated_at();
