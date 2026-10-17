CREATE TABLE "run_pipelines" (
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"gitlab_pipeline_id" bigint NOT NULL,
	"run_id" uuid NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_pipelines_project_id_gitlab_pipeline_id_pk" PRIMARY KEY("project_id","gitlab_pipeline_id"),
	CONSTRAINT "run_pipelines_action_check" CHECK ("run_pipelines"."action" in ('plan', 'apply')),
	CONSTRAINT "run_pipelines_pipeline_check" CHECK ("run_pipelines"."gitlab_pipeline_id" > 0)
);
--> statement-breakpoint
ALTER TABLE "run_stacks" ADD COLUMN "plan_job_id" bigint;--> statement-breakpoint
ALTER TABLE "run_stacks" ADD COLUMN "summary_job_id" bigint;--> statement-breakpoint
ALTER TABLE "run_stacks" ADD COLUMN "plan_add" integer;--> statement-breakpoint
ALTER TABLE "run_stacks" ADD COLUMN "plan_change" integer;--> statement-breakpoint
ALTER TABLE "run_stacks" ADD COLUMN "plan_destroy" integer;--> statement-breakpoint
ALTER TABLE "run_stacks" ADD COLUMN "plan_resources" jsonb;--> statement-breakpoint
ALTER TABLE "run_stacks" ADD COLUMN "summarized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run_pipelines" ADD CONSTRAINT "run_pipelines_run_fk" FOREIGN KEY ("run_id","organization_id","project_id") REFERENCES "public"."runs"("id","organization_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_pipelines_run_idx" ON "run_pipelines" USING btree ("run_id");--> statement-breakpoint
ALTER TABLE "run_stacks" ADD CONSTRAINT "run_stacks_jobs_check" CHECK (coalesce("run_stacks"."plan_job_id", 1) > 0 and coalesce("run_stacks"."summary_job_id", 1) > 0);--> statement-breakpoint
ALTER TABLE "run_stacks" ADD CONSTRAINT "run_stacks_summary_check" CHECK (("run_stacks"."plan_add" is null) = ("run_stacks"."plan_change" is null)
        and ("run_stacks"."plan_add" is null) = ("run_stacks"."plan_destroy" is null)
        and ("run_stacks"."plan_add" is null) = ("run_stacks"."plan_resources" is null)
        and ("run_stacks"."plan_add" is null) = ("run_stacks"."summarized_at" is null)
        and coalesce(least("run_stacks"."plan_add", "run_stacks"."plan_change", "run_stacks"."plan_destroy"), 0) >= 0
        and ("run_stacks"."plan_resources" is null or length("run_stacks"."plan_resources"::text) <= 4000000));--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): keep when editing this file.
CREATE TRIGGER run_pipelines_updated BEFORE UPDATE ON run_pipelines FOR EACH ROW EXECUTE FUNCTION set_updated_at();
