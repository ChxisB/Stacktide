CREATE TABLE "pipeline_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"connection_id" uuid,
	"gitlab_pipeline_id" bigint NOT NULL,
	"iid" integer NOT NULL,
	"status" text NOT NULL,
	"ref" text NOT NULL,
	"sha" text NOT NULL,
	"web_url" text NOT NULL,
	"failure_reason" text,
	"failed_job" text,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_runs_project_pipeline_key" UNIQUE("project_id","gitlab_pipeline_id"),
	CONSTRAINT "pipeline_runs_status_check" CHECK ("pipeline_runs"."status" ~ '^[a-z_]{1,32}$')
);
--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_project_org_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pipeline_runs_project_ref_idx" ON "pipeline_runs" USING btree ("project_id","ref","gitlab_pipeline_id");--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): keep when editing this file.
CREATE TRIGGER pipeline_runs_updated BEFORE UPDATE ON pipeline_runs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
