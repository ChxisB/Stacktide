CREATE TABLE "variable_keys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"dek_key_id" text NOT NULL,
	"dek_wrapped" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variable_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"variable_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"value_enc" "bytea" NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variable_versions_variable_version_key" UNIQUE("variable_id","version"),
	CONSTRAINT "variable_versions_version_check" CHECK ("variable_versions"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "variables" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"environment_id" uuid,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variables_scope_check" CHECK ("variables"."environment_id" IS NULL OR "variables"."project_id" IS NOT NULL),
	CONSTRAINT "variables_key_check" CHECK ("variables"."key" ~ '^[A-Za-z_][A-Za-z0-9_]{0,254}$'),
	CONSTRAINT "variables_kind_check" CHECK ("variables"."kind" IN ('plain', 'secret', 'file')),
	CONSTRAINT "variables_version_check" CHECK ("variables"."current_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_id_project_key" UNIQUE("id","project_id");
--> statement-breakpoint
ALTER TABLE "variable_keys" ADD CONSTRAINT "variable_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable_keys" ADD CONSTRAINT "variable_keys_project_org_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable_versions" ADD CONSTRAINT "variable_versions_variable_id_variables_id_fk" FOREIGN KEY ("variable_id") REFERENCES "public"."variables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variables" ADD CONSTRAINT "variables_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variables" ADD CONSTRAINT "variables_project_org_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variables" ADD CONSTRAINT "variables_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "public"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "variable_keys_org_key" ON "variable_keys" USING btree ("organization_id") WHERE "variable_keys"."project_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "variable_keys_project_key" ON "variable_keys" USING btree ("project_id") WHERE "variable_keys"."project_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "variables_scope_idx" ON "variables" USING btree ("organization_id","project_id");--> statement-breakpoint
CREATE INDEX "variables_environment_idx" ON "variables" USING btree ("environment_id") WHERE "variables"."environment_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "variables_org_key" ON "variables" USING btree ("organization_id","key") WHERE "variables"."project_id" IS NULL AND "variables"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "variables_project_key" ON "variables" USING btree ("project_id","key") WHERE "variables"."project_id" IS NOT NULL AND "variables"."environment_id" IS NULL AND "variables"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "variables_environment_key" ON "variables" USING btree ("environment_id","key") WHERE "variables"."environment_id" IS NOT NULL AND "variables"."deleted_at" IS NULL;
--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): keep when editing this file.
CREATE TRIGGER variable_keys_updated BEFORE UPDATE ON variable_keys FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER variables_updated BEFORE UPDATE ON variables FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE FUNCTION variable_versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	-- Only a cascade deletes versions: by then the variable they belong to is gone.
	IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM variables WHERE id = OLD.variable_id) THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION 'variable_versions is append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER variable_versions_no_change BEFORE UPDATE OR DELETE ON variable_versions FOR EACH ROW EXECUTE FUNCTION variable_versions_immutable();
--> statement-breakpoint
CREATE TRIGGER variable_versions_no_truncate BEFORE TRUNCATE ON variable_versions FOR EACH STATEMENT EXECUTE FUNCTION variable_versions_immutable();
