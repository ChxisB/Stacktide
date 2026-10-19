CREATE TABLE "worker_pools" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"tags" text[] NOT NULL,
	"image" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_pools_check" CHECK ("worker_pools"."name" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length("worker_pools"."name") <= 63
        and cardinality("worker_pools"."tags") <= 10
        and string_to_array(array_to_string("worker_pools"."tags", ','), ',') = "worker_pools"."tags"
        and array_to_string("worker_pools"."tags", ',') ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(,[A-Za-z0-9][A-Za-z0-9._-]{0,63})*$'
        and ("worker_pools"."image" is null or "worker_pools"."image" ~ '^[A-Za-z0-9][A-Za-z0-9._/:-]{0,254}(@sha256:[0-9a-f]{64})?$')),
	CONSTRAINT "worker_pools_default_enabled_check" CHECK (not "worker_pools"."is_default" or "worker_pools"."enabled")
);
--> statement-breakpoint
ALTER TABLE "worker_pools" ADD CONSTRAINT "worker_pools_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "worker_pools_org_name_key" ON "worker_pools" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_pools_one_default_key" ON "worker_pools" USING btree ("organization_id") WHERE "worker_pools"."is_default";--> statement-breakpoint
CREATE INDEX "worker_pools_org_idx" ON "worker_pools" USING btree ("organization_id","id");--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): keep when editing this file.
CREATE TRIGGER worker_pools_updated BEFORE UPDATE ON worker_pools FOR EACH ROW EXECUTE FUNCTION set_updated_at();
