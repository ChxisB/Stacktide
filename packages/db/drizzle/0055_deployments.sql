CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"connection_id" uuid,
	"gitlab_deployment_id" bigint NOT NULL,
	"environment" text NOT NULL,
	"sha" text NOT NULL,
	"ref" text NOT NULL,
	"status" text NOT NULL,
	"job_id" bigint,
	"pipeline_id" bigint,
	"finished_at" timestamp with time zone,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployments_project_deployment_key" UNIQUE("project_id","gitlab_deployment_id"),
	CONSTRAINT "deployments_status_check" CHECK ("deployments"."status" ~ '^[a-z_]{1,32}$')
);
--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_project_org_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deployments_project_env_idx" ON "deployments" USING btree ("project_id","environment","gitlab_deployment_id");--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): keep when editing this file.
CREATE TRIGGER deployments_updated BEFORE UPDATE ON deployments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
