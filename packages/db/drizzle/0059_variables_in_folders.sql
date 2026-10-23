-- Hand-ordered: the unique constraint on variable_folders comes first, the foreign key below targets it.
ALTER TABLE "variable_folders" ADD CONSTRAINT "variable_folders_id_project_key" UNIQUE("id","project_id");--> statement-breakpoint
DROP INDEX "variables_org_key";--> statement-breakpoint
DROP INDEX "variables_project_key";--> statement-breakpoint
DROP INDEX "variables_environment_key";--> statement-breakpoint
ALTER TABLE "variables" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "variables" ADD CONSTRAINT "variables_folder_fk" FOREIGN KEY ("folder_id","project_id") REFERENCES "public"."variable_folders"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "variables_org_key" ON "variables" USING btree ("organization_id",coalesce("folder_id", '00000000-0000-0000-0000-000000000000'::uuid),"key") WHERE "variables"."project_id" IS NULL AND "variables"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "variables_project_key" ON "variables" USING btree ("project_id",coalesce("folder_id", '00000000-0000-0000-0000-000000000000'::uuid),"key") WHERE "variables"."project_id" IS NOT NULL AND "variables"."environment_id" IS NULL AND "variables"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "variables_environment_key" ON "variables" USING btree ("environment_id",coalesce("folder_id", '00000000-0000-0000-0000-000000000000'::uuid),"key") WHERE "variables"."environment_id" IS NOT NULL AND "variables"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "variables" ADD CONSTRAINT "variables_folder_check" CHECK ("variables"."folder_id" IS NULL OR "variables"."project_id" IS NOT NULL);