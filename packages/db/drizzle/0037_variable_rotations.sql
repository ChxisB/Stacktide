CREATE TABLE "variable_rotations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"variable_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"interval_days" integer NOT NULL,
	"grace_days" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_at" timestamp with time zone NOT NULL,
	"last_at" timestamp with time zone,
	"last_status" text DEFAULT 'never' NOT NULL,
	"last_error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"handle" text,
	"previous_handle" text,
	"revoke_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variable_rotations_variable_key" UNIQUE("variable_id"),
	CONSTRAINT "variable_rotations_provider_check" CHECK ("variable_rotations"."provider" ~ '^[a-z][a-z0-9_-]{0,31}$'),
	CONSTRAINT "variable_rotations_config_check" CHECK (length("variable_rotations"."config"::text) <= 2000),
	CONSTRAINT "variable_rotations_interval_check" CHECK ("variable_rotations"."interval_days" between 1 and 365 and "variable_rotations"."grace_days" between 0 and "variable_rotations"."interval_days"),
	CONSTRAINT "variable_rotations_status_check" CHECK ("variable_rotations"."last_status" in ('never', 'ok', 'failing', 'pending_approval')
        and ("variable_rotations"."last_error" is null or "variable_rotations"."last_error" ~ '^[a-z0-9_]{1,40}$')
        and "variable_rotations"."attempts" >= 0),
	CONSTRAINT "variable_rotations_handle_check" CHECK (("variable_rotations"."handle" is null or "variable_rotations"."handle" ~ '^[A-Za-z0-9._:/@=+-]{1,200}$')
        and ("variable_rotations"."previous_handle" is null or "variable_rotations"."previous_handle" ~ '^[A-Za-z0-9._:/@=+-]{1,200}$')
        and ("variable_rotations"."previous_handle" is null) = ("variable_rotations"."revoke_at" is null))
);
--> statement-breakpoint
-- Hand-ordered (drizzle-kit puts this last): the composite key below needs it first.
ALTER TABLE "variables" ADD CONSTRAINT "variables_id_org_key" UNIQUE("id","organization_id");--> statement-breakpoint
ALTER TABLE "variable_rotations" ADD CONSTRAINT "variable_rotations_variable_org_fk" FOREIGN KEY ("variable_id","organization_id") REFERENCES "public"."variables"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "variable_rotations_org_idx" ON "variable_rotations" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "variable_rotations_due_idx" ON "variable_rotations" USING btree ("next_at") WHERE "variable_rotations"."enabled";--> statement-breakpoint
CREATE INDEX "variable_rotations_revoke_idx" ON "variable_rotations" USING btree ("revoke_at") WHERE "variable_rotations"."previous_handle" is not null;--> statement-breakpoint

-- Hand-written (drizzle-kit does not model triggers): keep when editing this file.
CREATE TRIGGER variable_rotations_updated BEFORE UPDATE ON variable_rotations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
