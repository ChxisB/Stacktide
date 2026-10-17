CREATE TABLE "run_stacks" (
	"run_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"stack" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_stacks_run_id_stack_pk" PRIMARY KEY("run_id","stack"),
	CONSTRAINT "run_stacks_stack_check" CHECK ("run_stacks"."stack" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
	CONSTRAINT "run_stacks_status_check" CHECK ("run_stacks"."status" in ('queued', 'planning', 'planned', 'applying', 'applied', 'failed', 'discarded', 'canceled')),
	CONSTRAINT "run_stacks_error_check" CHECK (length("run_stacks"."error") <= 500)
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"sha" text NOT NULL,
	"merge_request_iid" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runs_scope_key" UNIQUE("id","organization_id","project_id"),
	CONSTRAINT "runs_ref_check" CHECK (length("runs"."ref") between 1 and 255),
	CONSTRAINT "runs_sha_check" CHECK ("runs"."sha" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
	CONSTRAINT "runs_mr_check" CHECK ("runs"."merge_request_iid" is null or "runs"."merge_request_iid" > 0)
);
--> statement-breakpoint
ALTER TABLE "run_stacks" ADD CONSTRAINT "run_stacks_run_fk" FOREIGN KEY ("run_id","organization_id","project_id") REFERENCES "public"."runs"("id","organization_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_org_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_stacks_one_applying" ON "run_stacks" USING btree ("project_id","stack") WHERE "run_stacks"."status" = 'applying';--> statement-breakpoint
CREATE INDEX "runs_project_idx" ON "runs" USING btree ("project_id","id");
--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): keep when editing this file.
CREATE TRIGGER runs_updated BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER run_stacks_updated BEFORE UPDATE ON run_stacks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
