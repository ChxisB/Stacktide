CREATE TABLE "sso_memberships" (
	"user_id" uuid NOT NULL,
	"sso_provider_id" uuid NOT NULL,
	"role" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_memberships_user_id_sso_provider_id_pk" PRIMARY KEY("user_id","sso_provider_id"),
	CONSTRAINT "sso_memberships_role_check" CHECK ("sso_memberships"."role" in ('viewer', 'member', 'admin', 'owner'))
);
--> statement-breakpoint
ALTER TABLE "sso_memberships" ADD CONSTRAINT "sso_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_memberships" ADD CONSTRAINT "sso_memberships_sso_provider_id_sso_providers_id_fk" FOREIGN KEY ("sso_provider_id") REFERENCES "public"."sso_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): keep when editing this file.
CREATE TRIGGER sso_memberships_updated BEFORE UPDATE ON sso_memberships FOR EACH ROW EXECUTE FUNCTION set_updated_at();
