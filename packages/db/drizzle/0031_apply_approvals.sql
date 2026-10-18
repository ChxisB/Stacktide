ALTER TABLE "change_requests" DROP CONSTRAINT "change_requests_kind_check";--> statement-breakpoint
ALTER TABLE "change_requests" DROP CONSTRAINT "change_requests_ops_check";--> statement-breakpoint
ALTER TABLE "change_requests" ADD COLUMN "subject_id" uuid;--> statement-breakpoint
ALTER TABLE "change_requests" ADD COLUMN "subject" jsonb;--> statement-breakpoint
CREATE INDEX "change_requests_subject_idx" ON "change_requests" USING btree ("project_id","subject_id") WHERE "change_requests"."subject_id" is not null;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_subject_check" CHECK (("change_requests"."kind" = 'variables') = ("change_requests"."subject_id" is null));--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_kind_check" CHECK ("change_requests"."kind" in ('variables', 'sync_apply', 'iac_apply'));--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_ops_check" CHECK (case when "change_requests"."kind" = 'variables' then ("change_requests"."status" in ('open', 'approved')) = ("change_requests"."ops_enc" is not null) else "change_requests"."ops_enc" is null end);--> statement-breakpoint
-- Hand-written (drizzle-kit does not model functions): keep when editing this file.
-- The state machine of 0030, with what an approval to apply is for (`subject`) fixed from the day the
-- request is made, like the diff.
CREATE OR REPLACE FUNCTION change_requests_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.status IN ('applied', 'rejected', 'expired') THEN
		RAISE EXCEPTION 'a closed change request cannot change' USING ERRCODE = '55000';
	END IF;
	IF NEW.status <> OLD.status AND NOT (
		(OLD.status = 'open' AND NEW.status IN ('approved', 'applied', 'rejected', 'expired'))
		OR (OLD.status = 'approved' AND NEW.status IN ('applied', 'expired'))
		OR (OLD.status = 'approved' AND NEW.status = 'rejected' AND OLD.kind <> 'variables')
	) THEN
		RAISE EXCEPTION 'a change request cannot go from % to %', OLD.status, NEW.status USING ERRCODE = '55000';
	END IF;
	IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id OR NEW.project_id <> OLD.project_id
		OR NEW.environment_id <> OLD.environment_id OR NEW.kind <> OLD.kind OR NEW.diff <> OLD.diff
		OR NEW.subject_id IS DISTINCT FROM OLD.subject_id OR NEW.subject IS DISTINCT FROM OLD.subject
		OR NEW.author_kind <> OLD.author_kind OR NEW.author_id <> OLD.author_id OR NEW.author_ref <> OLD.author_ref
		OR NEW.expires_at <> OLD.expires_at
		OR (NEW.ops_enc IS NOT NULL AND NEW.ops_enc IS DISTINCT FROM OLD.ops_enc) THEN
		RAISE EXCEPTION 'a change request cannot be edited, only decided' USING ERRCODE = '55000';
	END IF;
	RETURN NEW;
END;
$$;
