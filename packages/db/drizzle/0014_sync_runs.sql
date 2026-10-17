CREATE TABLE "sync_run_items" (
	"run_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"key" text NOT NULL,
	"scope" text NOT NULL,
	"action" text NOT NULL,
	"changed" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_run_items_run_id_position_pk" PRIMARY KEY("run_id","position"),
	CONSTRAINT "sync_run_items_action_check" CHECK ("sync_run_items"."action" IN ('create', 'update', 'delete', 'noop', 'adopt'))
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"desired_digest" text NOT NULL,
	"counts" jsonb NOT NULL,
	"skipped" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_runs_status_check" CHECK ("sync_runs"."status" IN ('planned', 'applying', 'applied', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "sync_run_items" ADD CONSTRAINT "sync_run_items_run_id_sync_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sync_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- The unique key comes first: the foreign key below points at it.
ALTER TABLE "sync_targets" ADD CONSTRAINT "sync_targets_id_scope_key" UNIQUE("id","organization_id","project_id");--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_target_fk" FOREIGN KEY ("target_id","organization_id","project_id") REFERENCES "public"."sync_targets"("id","organization_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_runs_target_idx" ON "sync_runs" USING btree ("target_id","id");--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): keep when editing this file.
CREATE TRIGGER sync_runs_updated BEFORE UPDATE ON sync_runs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER sync_run_items_updated BEFORE UPDATE ON sync_run_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();
