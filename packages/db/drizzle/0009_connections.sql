CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_enc" "bytea" NOT NULL,
	"dek_key_id" text NOT NULL,
	"dek_wrapped" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_org_name_key" UNIQUE("organization_id","name"),
	CONSTRAINT "connections_id_org_key" UNIQUE("id","organization_id"),
	CONSTRAINT "connections_type_check" CHECK ("connections"."type" ~ '^[a-z][a-z0-9_]{0,31}$')
);
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): keep when editing this file.
CREATE TRIGGER connections_updated BEFORE UPDATE ON connections FOR EACH ROW EXECUTE FUNCTION set_updated_at();
