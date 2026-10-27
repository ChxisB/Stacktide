CREATE TABLE "resources" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"kind" text NOT NULL,
	"cloud" text NOT NULL,
	"name" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"stack" text NOT NULL,
	"path" text NOT NULL,
	"proposal_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resources_project_key" UNIQUE("project_id","environment","kind","name"),
	CONSTRAINT "resources_project_stack_key" UNIQUE("project_id","stack"),
	CONSTRAINT "resources_check" CHECK ("resources"."kind" in ('network', 'service', 'postgres', 'bucket')
        and "resources"."cloud" in ('gcp', 'aws')
        and length("resources"."environment") <= 12 and "resources"."environment" ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
        and length("resources"."name") <= 12 and "resources"."name" ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
        and "resources"."stack" = "resources"."environment" || '-' || "resources"."name" || '-' || "resources"."kind"),
	CONSTRAINT "resources_path_check" CHECK (length("resources"."path") <= 255
        and "resources"."path" ~ '^[A-Za-z0-9._@+=][A-Za-z0-9._@+=-]*(/[A-Za-z0-9._@+=][A-Za-z0-9._@+=-]*)*$'
        and "resources"."path" !~ '(^|/)\.{1,2}(/|$)'),
	CONSTRAINT "resources_proposal_check" CHECK ("resources"."proposal_url" is null or (length("resources"."proposal_url") <= 2000 and "resources"."proposal_url" ~ '^https?://')),
	CONSTRAINT "resources_inputs_check" CHECK (length("resources"."inputs"::text) <= 10000)
);
--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_project_org_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resources_project_idx" ON "resources" USING btree ("project_id","id");--> statement-breakpoint
CREATE INDEX "run_stacks_stack_idx" ON "run_stacks" USING btree ("project_id","stack","run_id");--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): keep when editing this file.
CREATE TRIGGER resources_updated BEFORE UPDATE ON resources FOR EACH ROW EXECUTE FUNCTION set_updated_at();