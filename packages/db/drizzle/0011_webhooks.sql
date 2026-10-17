CREATE TABLE "webhook_deliveries" (
	"connection_id" uuid NOT NULL,
	"delivery_id" text NOT NULL,
	"event" text NOT NULL,
	"job_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_connection_id_delivery_id_pk" PRIMARY KEY("connection_id","delivery_id")
);
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "webhook_secret_hash" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_received_idx" ON "webhook_deliveries" USING btree ("received_at");