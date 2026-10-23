-- Additive, except that the one unique index on (organization, GitLab project) becomes two: this one for unbound projects (every existing row) and one per connection.

DROP INDEX "projects_org_gitlab_project_key";--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_connection_org_fk" FOREIGN KEY ("connection_id","organization_id") REFERENCES "public"."connections"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_connection_gitlab_project_key" ON "projects" USING btree ("connection_id","gitlab_project_id") WHERE "projects"."gitlab_project_id" IS NOT NULL AND "projects"."connection_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_org_gitlab_project_key" ON "projects" USING btree ("organization_id","gitlab_project_id") WHERE "projects"."gitlab_project_id" IS NOT NULL AND "projects"."connection_id" IS NULL;