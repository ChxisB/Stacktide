CREATE TABLE "notification_sinks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"host" text NOT NULL,
	"secret_enc" "bytea" NOT NULL,
	"dek_key_id" text NOT NULL,
	"dek_wrapped" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_sinks_org_name_key" UNIQUE("organization_id","name"),
	CONSTRAINT "notification_sinks_id_org_key" UNIQUE("id","organization_id"),
	CONSTRAINT "notification_sinks_kind_check" CHECK ("notification_sinks"."kind" in ('webhook', 'slack'))
);
--> statement-breakpoint
CREATE TABLE "notification_subscriptions" (
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"sink_id" uuid NOT NULL,
	"event" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_subscriptions_sink_id_project_id_event_pk" PRIMARY KEY("sink_id","project_id","event"),
	CONSTRAINT "notification_subscriptions_event_check" CHECK ("notification_subscriptions"."event" in ('stack.drift'))
);
--> statement-breakpoint
ALTER TABLE "notification_sinks" ADD CONSTRAINT "notification_sinks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_subscriptions" ADD CONSTRAINT "notification_subscriptions_sink_org_fk" FOREIGN KEY ("sink_id","organization_id") REFERENCES "public"."notification_sinks"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_subscriptions" ADD CONSTRAINT "notification_subscriptions_project_org_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_subscriptions_project_idx" ON "notification_subscriptions" USING btree ("project_id");--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): keep when editing this file.
CREATE TRIGGER notification_sinks_updated BEFORE UPDATE ON notification_sinks FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER notification_subscriptions_updated BEFORE UPDATE ON notification_subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
