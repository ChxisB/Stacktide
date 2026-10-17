CREATE TABLE "sync_targets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"environment_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"unmanaged_policy" text DEFAULT 'ignore' NOT NULL,
	"auto_sync" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_targets_project_name_key" UNIQUE("project_id","name"),
	CONSTRAINT "sync_targets_type_check" CHECK ("sync_targets"."type" ~ '^[a-z][a-z0-9_-]{0,63}$'),
	CONSTRAINT "sync_targets_unmanaged_policy_check" CHECK ("sync_targets"."unmanaged_policy" IN ('ignore', 'adopt', 'prune'))
);
--> statement-breakpoint
ALTER TABLE "sync_targets" ADD CONSTRAINT "sync_targets_project_org_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_targets" ADD CONSTRAINT "sync_targets_connection_org_fk" FOREIGN KEY ("connection_id","organization_id") REFERENCES "public"."connections"("id","organization_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): keep when editing this file.
CREATE TRIGGER sync_targets_updated BEFORE UPDATE ON sync_targets FOR EACH ROW EXECUTE FUNCTION set_updated_at();
