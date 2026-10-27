ALTER TABLE "resources" ADD COLUMN "url" text;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "console_url" text;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "outputs_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_outputs_check" CHECK (("resources"."url" is null or (length("resources"."url") <= 300 and "resources"."url" ~ '^https?://[!-~]+$'))
        and ("resources"."console_url" is null or (length("resources"."console_url") <= 300 and "resources"."console_url" ~ '^https?://[!-~]+$')));