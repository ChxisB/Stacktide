CREATE TABLE "change_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"diff" jsonb NOT NULL,
	"ops_enc" "bytea",
	"author_kind" text NOT NULL,
	"author_id" text NOT NULL,
	"author_ref" text NOT NULL,
	"decided_by_kind" text,
	"decided_by_id" text,
	"decided_by_ref" text,
	"decided_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_requests_kind_check" CHECK ("change_requests"."kind" in ('variables')),
	CONSTRAINT "change_requests_status_check" CHECK ("change_requests"."status" in ('open', 'approved', 'applied', 'rejected', 'expired')),
	CONSTRAINT "change_requests_ops_check" CHECK (("change_requests"."status" in ('open', 'approved')) = ("change_requests"."ops_enc" is not null)),
	CONSTRAINT "change_requests_four_eyes_check" CHECK ("change_requests"."status" not in ('approved', 'applied') or ("change_requests"."decided_by_ref" is not null and "change_requests"."decided_by_ref" <> "change_requests"."author_ref"))
);
--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "protected" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "public"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_project_org_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "change_requests_env_idx" ON "change_requests" USING btree ("environment_id","status","id");--> statement-breakpoint
CREATE INDEX "change_requests_expiry_idx" ON "change_requests" USING btree ("expires_at") WHERE "change_requests"."status" in ('open', 'approved');--> statement-breakpoint
CREATE TRIGGER change_requests_updated BEFORE UPDATE ON change_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- Hand-written (drizzle-kit does not model functions): keep when editing this file.
-- The state machine, below the application: a closed request never changes again, the only moves are
-- open -> approved | applied | rejected | expired and approved -> applied | expired, and what the
-- approvers were shown (the diff, the sealed edits, the author, where it applies, when it lapses) is
-- fixed from the day the request is made. The sealed edits may only be dropped.
--> statement-breakpoint
CREATE FUNCTION change_requests_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.status IN ('applied', 'rejected', 'expired') THEN
		RAISE EXCEPTION 'a closed change request cannot change' USING ERRCODE = '55000';
	END IF;
	IF NEW.status <> OLD.status AND NOT (
		(OLD.status = 'open' AND NEW.status IN ('approved', 'applied', 'rejected', 'expired'))
		OR (OLD.status = 'approved' AND NEW.status IN ('applied', 'expired'))
	) THEN
		RAISE EXCEPTION 'a change request cannot go from % to %', OLD.status, NEW.status USING ERRCODE = '55000';
	END IF;
	IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id OR NEW.project_id <> OLD.project_id
		OR NEW.environment_id <> OLD.environment_id OR NEW.kind <> OLD.kind OR NEW.diff <> OLD.diff
		OR NEW.author_kind <> OLD.author_kind OR NEW.author_id <> OLD.author_id OR NEW.author_ref <> OLD.author_ref
		OR NEW.expires_at <> OLD.expires_at
		OR (NEW.ops_enc IS NOT NULL AND NEW.ops_enc IS DISTINCT FROM OLD.ops_enc) THEN
		RAISE EXCEPTION 'a change request cannot be edited, only decided' USING ERRCODE = '55000';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER change_requests_state BEFORE UPDATE ON change_requests FOR EACH ROW EXECUTE FUNCTION change_requests_transition();
