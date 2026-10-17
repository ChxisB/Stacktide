CREATE TABLE "stacks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"tool" text NOT NULL,
	"version" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"depends_on" text[] DEFAULT '{}'::text[] NOT NULL,
	"watch" text[] DEFAULT '{}'::text[] NOT NULL,
	"apply_on" text DEFAULT 'command' NOT NULL,
	"backend" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stacks_project_name_key" UNIQUE("project_id","name"),
	CONSTRAINT "stacks_path_check" CHECK ("stacks"."path" = '.' or ("stacks"."path" ~ '^[A-Za-z0-9._@+=][A-Za-z0-9._@+=-]*(/[A-Za-z0-9._@+=][A-Za-z0-9._@+=-]*)*$' and "stacks"."path" !~ '(^|/)[.][.]?(/|$)')),
	CONSTRAINT "stacks_name_check" CHECK ("stacks"."name" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
	CONSTRAINT "stacks_tool_check" CHECK ("stacks"."tool" in ('terraform', 'tofu', 'terragrunt')),
	CONSTRAINT "stacks_apply_on_check" CHECK ("stacks"."apply_on" in ('merge', 'command')),
	CONSTRAINT "stacks_backend_check" CHECK ("stacks"."backend" in ('http', 'other', 'none', 'unchecked'))
);
--> statement-breakpoint
ALTER TABLE "stacks" ADD CONSTRAINT "stacks_project_org_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): keep when editing this file.
CREATE TRIGGER stacks_updated BEFORE UPDATE ON stacks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
