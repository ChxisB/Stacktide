ALTER TABLE "change_requests" DROP CONSTRAINT "change_requests_kind_check";--> statement-breakpoint
ALTER TABLE "change_requests" DROP CONSTRAINT "change_requests_subject_check";--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_kind_check" CHECK ("change_requests"."kind" in ('variables', 'sync_apply', 'iac_apply', 'deploy'));--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_subject_check" CHECK (("change_requests"."kind" in ('variables', 'deploy')) = ("change_requests"."subject_id" is null));