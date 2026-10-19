CREATE TABLE "secret_leases" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"principal" text NOT NULL,
	"provider" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"remote_project_id" bigint NOT NULL,
	"scopes" text NOT NULL,
	"handle" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secret_leases_provider_check" CHECK ("secret_leases"."provider" ~ '^[a-z][a-z0-9_-]{0,31}$'),
	CONSTRAINT "secret_leases_principal_check" CHECK ("secret_leases"."principal" ~ '^[a-z]{1,16}:[A-Za-z0-9._:@=+-]{1,120}$'),
	CONSTRAINT "secret_leases_scopes_check" CHECK ("secret_leases"."scopes" ~ '^[a-z_]{1,32}(,[a-z_]{1,32}){0,7}$'),
	CONSTRAINT "secret_leases_handle_check" CHECK ("secret_leases"."handle" is null or "secret_leases"."handle" ~ '^[A-Za-z0-9._:/@=+-]{1,200}$')
);
--> statement-breakpoint
ALTER TABLE "secret_leases" ADD CONSTRAINT "secret_leases_project_org_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "secret_leases_project_idx" ON "secret_leases" USING btree ("organization_id","project_id","id");--> statement-breakpoint
CREATE INDEX "secret_leases_live_idx" ON "secret_leases" USING btree ("principal","expires_at") WHERE "secret_leases"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "secret_leases_due_idx" ON "secret_leases" USING btree ("expires_at") WHERE "secret_leases"."revoked_at" is null and "secret_leases"."handle" is not null;--> statement-breakpoint

-- Hand-written (drizzle-kit does not model triggers): keep when editing this file.
CREATE TRIGGER secret_leases_updated BEFORE UPDATE ON secret_leases FOR EACH ROW EXECUTE FUNCTION set_updated_at();
