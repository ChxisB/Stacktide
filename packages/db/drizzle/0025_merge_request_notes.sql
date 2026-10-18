CREATE TABLE "merge_request_notes" (
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"merge_request_iid" integer NOT NULL,
	"note_id" bigint,
	"notice" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merge_request_notes_project_id_merge_request_iid_pk" PRIMARY KEY("project_id","merge_request_iid"),
	CONSTRAINT "merge_request_notes_iid_check" CHECK ("merge_request_notes"."merge_request_iid" > 0),
	CONSTRAINT "merge_request_notes_note_check" CHECK (coalesce("merge_request_notes"."note_id", 1) > 0),
	CONSTRAINT "merge_request_notes_notice_check" CHECK (length("merge_request_notes"."notice") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "merge_request_notes" ADD CONSTRAINT "merge_request_notes_project_org_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): keep when editing this file.
CREATE TRIGGER merge_request_notes_updated BEFORE UPDATE ON merge_request_notes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
