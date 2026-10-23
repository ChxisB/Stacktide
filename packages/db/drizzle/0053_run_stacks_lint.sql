ALTER TABLE "run_stacks" ADD COLUMN "lint_errors" integer;--> statement-breakpoint
ALTER TABLE "run_stacks" ADD COLUMN "lint_warnings" integer;--> statement-breakpoint
ALTER TABLE "run_stacks" ADD CONSTRAINT "run_stacks_lint_check" CHECK (("run_stacks"."lint_errors" is null) = ("run_stacks"."lint_warnings" is null)
        and ("run_stacks"."lint_errors" is null or (
          "run_stacks"."summarized_at" is not null
          and "run_stacks"."lint_errors" between 0 and 1000000
          and "run_stacks"."lint_warnings" between 0 and 1000000)));