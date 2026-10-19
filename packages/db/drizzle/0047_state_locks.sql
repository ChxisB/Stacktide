CREATE TABLE "state_locks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"stack_name" text NOT NULL,
	"lock_id" text NOT NULL,
	"owner" text NOT NULL,
	"info" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "state_locks_stack_key" UNIQUE("project_id","stack_name"),
	CONSTRAINT "state_locks_stack_name_check" CHECK ("state_locks"."stack_name" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
	CONSTRAINT "state_locks_lock_id_check" CHECK (length("state_locks"."lock_id") between 1 and 256)
);
--> statement-breakpoint
ALTER TABLE "state_locks" ADD CONSTRAINT "state_locks_project_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;