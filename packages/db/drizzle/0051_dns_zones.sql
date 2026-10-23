CREATE TABLE "dns_zones" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"zone" text NOT NULL,
	"stack" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dns_zones_check" CHECK (length("dns_zones"."zone") <= 253
        and "dns_zones"."zone" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
        and "dns_zones"."stack" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')
);
--> statement-breakpoint
ALTER TABLE "dns_zones" ADD CONSTRAINT "dns_zones_project_org_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dns_zones_org_zone_key" ON "dns_zones" USING btree ("organization_id","zone");--> statement-breakpoint
CREATE INDEX "dns_zones_project_idx" ON "dns_zones" USING btree ("project_id","id");--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): keep when editing this file.
CREATE TRIGGER dns_zones_updated BEFORE UPDATE ON dns_zones FOR EACH ROW EXECUTE FUNCTION set_updated_at();
