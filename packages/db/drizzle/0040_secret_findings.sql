CREATE TABLE "secret_findings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"rule" text NOT NULL,
	"path" text NOT NULL,
	"line" integer,
	"commit" text NOT NULL,
	"severity" text NOT NULL,
	"ref" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"dismissed_reason" text,
	"dismissed_by" text,
	"dismissed_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secret_findings_status_check" CHECK ("secret_findings"."status" in ('open', 'dismissed', 'resolved')),
	CONSTRAINT "secret_findings_severity_check" CHECK ("secret_findings"."severity" in ('info', 'unknown', 'low', 'medium', 'high', 'critical')),
	CONSTRAINT "secret_findings_fingerprint_check" CHECK ("secret_findings"."fingerprint" ~ '^[A-Za-z0-9_.:-]{1,100}$'),
	CONSTRAINT "secret_findings_rule_check" CHECK ("secret_findings"."rule" ~ '^[a-z][a-z0-9-]{0,99}$'),
	CONSTRAINT "secret_findings_commit_check" CHECK ("secret_findings"."commit" ~* '^[0-9a-f]{7,64}$'),
	CONSTRAINT "secret_findings_path_check" CHECK (char_length("secret_findings"."path") between 1 and 1024),
	CONSTRAINT "secret_findings_ref_check" CHECK (char_length("secret_findings"."ref") between 1 and 255),
	CONSTRAINT "secret_findings_line_check" CHECK ("secret_findings"."line" is null or "secret_findings"."line" >= 1),
	CONSTRAINT "secret_findings_dismissed_by_check" CHECK ("secret_findings"."dismissed_by" is null or "secret_findings"."dismissed_by" ~ '^[a-z]{1,16}:[A-Za-z0-9._:@=+-]{1,120}$'),
	CONSTRAINT "secret_findings_reason_check" CHECK ("secret_findings"."dismissed_reason" is null or char_length("secret_findings"."dismissed_reason") between 1 and 1000),
	CONSTRAINT "secret_findings_dismissal_check" CHECK (("secret_findings"."status" = 'dismissed') = ("secret_findings"."dismissed_reason" is not null and "secret_findings"."dismissed_by" is not null and "secret_findings"."dismissed_at" is not null) and ("secret_findings"."status" = 'dismissed' or ("secret_findings"."dismissed_reason" is null and "secret_findings"."dismissed_by" is null and "secret_findings"."dismissed_at" is null)))
);
--> statement-breakpoint
ALTER TABLE "secret_findings" ADD CONSTRAINT "secret_findings_project_org_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "secret_findings_fingerprint_idx" ON "secret_findings" USING btree ("project_id","fingerprint");--> statement-breakpoint
CREATE INDEX "secret_findings_project_idx" ON "secret_findings" USING btree ("organization_id","project_id","id");
--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): keep when editing this file.
CREATE TRIGGER secret_findings_updated BEFORE UPDATE ON secret_findings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
