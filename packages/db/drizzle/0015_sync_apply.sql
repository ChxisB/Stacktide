ALTER TABLE "sync_run_items" ADD COLUMN "result" text;--> statement-breakpoint
ALTER TABLE "sync_run_items" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "job_id" uuid;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "error" text;--> statement-breakpoint
CREATE UNIQUE INDEX "sync_runs_one_applying" ON "sync_runs" USING btree ("target_id") WHERE "sync_runs"."status" = 'applying';--> statement-breakpoint
ALTER TABLE "sync_run_items" ADD CONSTRAINT "sync_run_items_result_check" CHECK ("sync_run_items"."result" IN ('applied', 'failed'));