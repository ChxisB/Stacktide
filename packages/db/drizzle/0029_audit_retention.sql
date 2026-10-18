ALTER TABLE "organizations" ADD COLUMN "audit_retention_days" integer;--> statement-breakpoint
CREATE INDEX "audit_events_org_id_idx" ON "audit_events" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_audit_retention_check" CHECK ("organizations"."audit_retention_days" is null or "organizations"."audit_retention_days" between 30 and 3650);
-- Hand-written (drizzle-kit does not model functions): keep when editing this file.
-- audit_events stays append-only except for one path: audit_purge_expired() below turns on a
-- transaction-local flag for its own DELETE and off again. It takes no cutoff: what it deletes is
-- decided by organizations.audit_retention_days alone, and an organization with none (or none at all,
-- as with events that name no organization) is never touched. UPDATE and TRUNCATE are refused as before.
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' AND current_setting('orch.audit_purge', true) = 'on' THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION audit_purge_expired(batch integer) RETURNS TABLE (org_id uuid, purged bigint) LANGUAGE plpgsql AS $$
DECLARE
	o record;
	room integer := batch;
	n bigint;
BEGIN
	IF batch IS NULL OR batch < 1 OR batch > 10000 THEN
		RAISE EXCEPTION 'batch must be from 1 to 10000' USING ERRCODE = '22023';
	END IF;
	PERFORM set_config('orch.audit_purge', 'on', true);
	-- One organization at a time, so each delete is a range of its (organization_id, at) index.
	FOR o IN SELECT id, audit_retention_days AS days FROM organizations WHERE audit_retention_days IS NOT NULL ORDER BY id LOOP
		EXIT WHEN room <= 0;
		WITH gone AS (
			DELETE FROM audit_events WHERE id IN (
				SELECT a.id FROM audit_events a
				WHERE a.organization_id = o.id AND a.at < now() - make_interval(days => o.days)
				ORDER BY a.at, a.id LIMIT room
			) RETURNING 1
		)
		SELECT count(*) INTO n FROM gone;
		IF n > 0 THEN
			org_id := o.id;
			purged := n;
			room := room - n;
			RETURN NEXT;
		END IF;
	END LOOP;
	PERFORM set_config('orch.audit_purge', 'off', true);
END;
$$;
