ALTER TABLE "resources" DROP CONSTRAINT "resources_check";--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_check" CHECK ("resources"."kind" in ('network', 'service', 'postgres', 'bucket', 'deploy-identity')
        and "resources"."cloud" in ('gcp', 'aws')
        and length("resources"."environment") <= 12 and "resources"."environment" ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
        and length("resources"."name") <= 12 and "resources"."name" ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
        and "resources"."stack" = "resources"."environment" || '-' || "resources"."name" || '-' || "resources"."kind");