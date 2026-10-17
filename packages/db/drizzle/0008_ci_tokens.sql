CREATE TABLE "ci_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid,
	"token_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"gitlab_project_id" bigint NOT NULL,
	"gitlab_job_id" bigint,
	"ref" text NOT NULL,
	"ref_protected" boolean NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ci_tokens_token_hash_key" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "ci_tokens" ADD CONSTRAINT "ci_tokens_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_tokens" ADD CONSTRAINT "ci_tokens_project_org_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ci_tokens_expires_idx" ON "ci_tokens" USING btree ("expires_at");