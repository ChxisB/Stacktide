CREATE TABLE "state_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"stack_name" text NOT NULL,
	"serial" integer NOT NULL,
	"lineage" text NOT NULL,
	"state_enc" "bytea" NOT NULL,
	"dek_key_id" text NOT NULL,
	"dek_wrapped" "bytea" NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "state_versions_serial_key" UNIQUE("project_id","stack_name","serial"),
	CONSTRAINT "state_versions_stack_name_check" CHECK ("state_versions"."stack_name" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
	CONSTRAINT "state_versions_serial_check" CHECK ("state_versions"."serial" >= 0),
	CONSTRAINT "state_versions_lineage_check" CHECK (length("state_versions"."lineage") between 1 and 256)
);
--> statement-breakpoint
ALTER TABLE "state_versions" ADD CONSTRAINT "state_versions_project_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE restrict ON UPDATE no action;