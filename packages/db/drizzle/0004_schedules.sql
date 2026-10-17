CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"cron" text,
	"interval_seconds" integer,
	"queue" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedules_name_key" UNIQUE("name"),
	CONSTRAINT "schedules_kind_check" CHECK (("schedules"."cron" is null) <> ("schedules"."interval_seconds" is null)),
	CONSTRAINT "schedules_interval_check" CHECK ("schedules"."interval_seconds" is null or "schedules"."interval_seconds" >= 1)
);
--> statement-breakpoint
CREATE INDEX "schedules_due_idx" ON "schedules" USING btree ("next_run_at") WHERE "schedules"."enabled";
--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): keep when editing this file.
CREATE TRIGGER schedules_updated BEFORE UPDATE ON schedules FOR EACH ROW EXECUTE FUNCTION set_updated_at();
