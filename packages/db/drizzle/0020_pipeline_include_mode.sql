ALTER TABLE "pipeline_configs" ADD COLUMN "mode" text DEFAULT 'inline' NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_configs" ADD COLUMN "include_project" text;--> statement-breakpoint
ALTER TABLE "pipeline_configs" ADD COLUMN "include_ref" text;--> statement-breakpoint
ALTER TABLE "pipeline_configs" ADD CONSTRAINT "pipeline_configs_mode_check" CHECK ("pipeline_configs"."mode" in ('inline', 'include'));--> statement-breakpoint
ALTER TABLE "pipeline_configs" ADD CONSTRAINT "pipeline_configs_include_check" CHECK (("pipeline_configs"."mode" = 'include') = ("pipeline_configs"."include_project" is not null) and ("pipeline_configs"."include_ref" is null or "pipeline_configs"."include_project" is not null));