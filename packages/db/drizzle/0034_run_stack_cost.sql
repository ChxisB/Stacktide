ALTER TABLE "run_stacks" ADD COLUMN "cost_monthly_delta" double precision;--> statement-breakpoint
ALTER TABLE "run_stacks" ADD COLUMN "cost_monthly_total" double precision;--> statement-breakpoint
ALTER TABLE "run_stacks" ADD COLUMN "cost_currency" text;--> statement-breakpoint
ALTER TABLE "run_stacks" ADD COLUMN "cost_tool" text;--> statement-breakpoint
ALTER TABLE "run_stacks" ADD CONSTRAINT "run_stacks_cost_check" CHECK (("run_stacks"."cost_monthly_delta" is null) = ("run_stacks"."cost_monthly_total" is null)
        and ("run_stacks"."cost_monthly_delta" is null) = ("run_stacks"."cost_currency" is null)
        and ("run_stacks"."cost_monthly_delta" is null) = ("run_stacks"."cost_tool" is null)
        and ("run_stacks"."cost_monthly_delta" is null or (
          "run_stacks"."summarized_at" is not null
          and abs("run_stacks"."cost_monthly_delta") <= 1e12
          and "run_stacks"."cost_monthly_total" between 0 and 1e12
          and "run_stacks"."cost_currency" ~ '^[A-Z]{3}$'
          and "run_stacks"."cost_tool" ~ '^[a-z0-9][a-z0-9._-]{0,39}$')));