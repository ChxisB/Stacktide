CREATE TABLE "run_plans" (
	"run_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"action" text NOT NULL,
	"plan" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_plans_run_id_action_pk" PRIMARY KEY("run_id","action"),
	CONSTRAINT "run_plans_action_check" CHECK ("run_plans"."action" in ('plan', 'apply')),
	CONSTRAINT "run_plans_size_check" CHECK (length("run_plans"."plan"::text) <= 4000000)
);
--> statement-breakpoint
ALTER TABLE "run_plans" ADD CONSTRAINT "run_plans_run_fk" FOREIGN KEY ("run_id","organization_id","project_id") REFERENCES "public"."runs"("id","organization_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): keep when editing this file.
CREATE TRIGGER run_plans_updated BEFORE UPDATE ON run_plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();
