CREATE TABLE "sync_target_drift" (
	"target_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text NOT NULL,
	"counts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_target_drift_status_check" CHECK ("sync_target_drift"."status" IN ('in_sync', 'drifted'))
);
--> statement-breakpoint
ALTER TABLE "sync_targets" ADD COLUMN "auto_remediate" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_target_drift" ADD CONSTRAINT "sync_target_drift_target_fk" FOREIGN KEY ("target_id","organization_id","project_id") REFERENCES "public"."sync_targets"("id","organization_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): keep when editing this file.
CREATE TRIGGER sync_target_drift_updated BEFORE UPDATE ON sync_target_drift FOR EACH ROW EXECUTE FUNCTION set_updated_at();
