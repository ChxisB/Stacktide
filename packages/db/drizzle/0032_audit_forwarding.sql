CREATE TABLE "audit_forwards" (
	"sink_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"cursor" uuid NOT NULL,
	"delivered_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_forwards_failures_check" CHECK ("audit_forwards"."failures" >= 0)
);
--> statement-breakpoint
ALTER TABLE "notification_sinks" DROP CONSTRAINT "notification_sinks_kind_check";--> statement-breakpoint
ALTER TABLE "audit_forwards" ADD CONSTRAINT "audit_forwards_sink_org_fk" FOREIGN KEY ("sink_id","organization_id") REFERENCES "public"."notification_sinks"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_forwards_due_idx" ON "audit_forwards" USING btree ("next_attempt_at");--> statement-breakpoint
ALTER TABLE "notification_sinks" ADD CONSTRAINT "notification_sinks_kind_check" CHECK ("notification_sinks"."kind" in ('webhook', 'slack', 'syslog', 'datadog', 'splunk'));--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): keep when editing this file.
CREATE TRIGGER audit_forwards_updated BEFORE UPDATE ON audit_forwards FOR EACH ROW EXECUTE FUNCTION set_updated_at();