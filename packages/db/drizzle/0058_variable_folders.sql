CREATE TABLE "variable_folders" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"path" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variable_folders_path_check" CHECK ("variable_folders"."path" ~ '^(/[a-z0-9_-]{1,32}){1,5}$')
);
--> statement-breakpoint
ALTER TABLE "variable_folders" ADD CONSTRAINT "variable_folders_project_org_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "variable_folders_project_path" ON "variable_folders" USING btree ("project_id","path") WHERE "variable_folders"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "variable_folders_project_idx" ON "variable_folders" USING btree ("project_id");--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): keep when editing this file.
CREATE TRIGGER variable_folders_updated BEFORE UPDATE ON variable_folders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
