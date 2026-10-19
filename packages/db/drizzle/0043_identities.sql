CREATE TABLE "sso_providers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text NOT NULL,
	"secret_enc" "bytea" NOT NULL,
	"dek_key_id" text NOT NULL,
	"dek_wrapped" "bytea" NOT NULL,
	"email_domains" text[] NOT NULL,
	"role_map" text DEFAULT '[]' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_providers_org_key" UNIQUE("organization_id")
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"sso_provider_id" uuid,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_identities_provider_subject_key" UNIQUE("provider","subject"),
	CONSTRAINT "user_identities_provider_check" CHECK (("user_identities"."provider" = 'gitlab' and "user_identities"."sso_provider_id" is null)
        or ("user_identities"."sso_provider_id" is not null and "user_identities"."provider" = 'sso:' || "user_identities"."sso_provider_id"::text))
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "gitlab_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_sso_provider_id_sso_providers_id_fk" FOREIGN KEY ("sso_provider_id") REFERENCES "public"."sso_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_identities_user_idx" ON "user_identities" USING btree ("user_id");--> statement-breakpoint
-- backfill: every person who exists signs in with GitLab, so give each one a gitlab identity (safe to run again)
INSERT INTO user_identities (user_id, provider, subject) SELECT id, 'gitlab', gitlab_id::text FROM users WHERE gitlab_id IS NOT NULL ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): keep when editing this file.
CREATE TRIGGER sso_providers_updated BEFORE UPDATE ON sso_providers FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER user_identities_updated BEFORE UPDATE ON user_identities FOR EACH ROW EXECUTE FUNCTION set_updated_at();
