CREATE TABLE "state_resources" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"version_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"stack_name" text NOT NULL,
	"address" text NOT NULL,
	"mode" text NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"module" text,
	"index_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "state_resources_address_key" UNIQUE("version_id","address"),
	CONSTRAINT "state_resources_mode_check" CHECK ("state_resources"."mode" in ('managed', 'data'))
);
--> statement-breakpoint
ALTER TABLE "state_resources" ADD CONSTRAINT "state_resources_version_id_state_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."state_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "state_resources_stack_idx" ON "state_resources" USING btree ("project_id","stack_name","address");