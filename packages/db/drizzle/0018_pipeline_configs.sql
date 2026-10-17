CREATE TABLE "pipeline_configs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"template" text NOT NULL,
	"version" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rendered_hash" text NOT NULL,
	"mr_iid" integer,
	"mr_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_configs_project_key" UNIQUE("project_id"),
	CONSTRAINT "pipeline_configs_hash_check" CHECK ("pipeline_configs"."rendered_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "pipeline_configs" ADD CONSTRAINT "pipeline_configs_project_org_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_configs" ADD CONSTRAINT "pipeline_configs_connection_org_fk" FOREIGN KEY ("connection_id","organization_id") REFERENCES "public"."connections"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): keep when editing this file.
CREATE TRIGGER pipeline_configs_updated BEFORE UPDATE ON pipeline_configs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
