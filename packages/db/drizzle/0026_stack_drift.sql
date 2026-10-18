CREATE TABLE "stack_drift" (
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"stack" text NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"since" timestamp with time zone,
	"requested_at" timestamp with time zone NOT NULL,
	"checked_at" timestamp with time zone,
	"plan_add" integer,
	"plan_change" integer,
	"plan_destroy" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stack_drift_project_id_stack_pk" PRIMARY KEY("project_id","stack"),
	CONSTRAINT "stack_drift_stack_check" CHECK ("stack_drift"."stack" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
	CONSTRAINT "stack_drift_status_check" CHECK ("stack_drift"."status" in ('unknown', 'clean', 'drifted')),
	CONSTRAINT "stack_drift_found_check" CHECK (("stack_drift"."status" = 'unknown') = ("stack_drift"."checked_at" is null)
        and ("stack_drift"."status" = 'unknown') = ("stack_drift"."plan_add" is null)
        and ("stack_drift"."status" = 'unknown') = ("stack_drift"."plan_change" is null)
        and ("stack_drift"."status" = 'unknown') = ("stack_drift"."plan_destroy" is null)
        and ("stack_drift"."status" = 'drifted') = ("stack_drift"."since" is not null)
        and coalesce(least("stack_drift"."plan_add", "stack_drift"."plan_change", "stack_drift"."plan_destroy"), 0) >= 0
        and ("stack_drift"."status" <> 'drifted' or "stack_drift"."plan_add" + "stack_drift"."plan_change" + "stack_drift"."plan_destroy" > 0)
        and ("stack_drift"."status" <> 'clean' or "stack_drift"."plan_add" + "stack_drift"."plan_change" + "stack_drift"."plan_destroy" = 0))
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "kind" text DEFAULT 'plan' NOT NULL;--> statement-breakpoint
ALTER TABLE "stack_drift" ADD CONSTRAINT "stack_drift_project_org_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_kind_check" CHECK ("runs"."kind" in ('plan', 'drift'));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_drift_check" CHECK ("runs"."kind" <> 'drift' or "runs"."merge_request_iid" is null);--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): keep when editing this file.
CREATE TRIGGER stack_drift_updated BEFORE UPDATE ON stack_drift FOR EACH ROW EXECUTE FUNCTION set_updated_at();
