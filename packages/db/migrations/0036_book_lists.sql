CREATE TABLE "book_lists" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"class_level_id" uuid NOT NULL,
	"start_year" integer NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "book_lists_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "book_lists_level_year_key" UNIQUE("school_id","class_level_id","start_year"),
	CONSTRAINT "book_lists_at_most_80" CHECK (jsonb_array_length("book_lists"."items") <= 80),
	CONSTRAINT "book_lists_shared_not_empty" CHECK (NOT "book_lists"."shared" OR jsonb_array_length("book_lists"."items") > 0)
);
--> statement-breakpoint
ALTER TABLE "book_lists" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "book_lists" ADD CONSTRAINT "book_lists_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_lists" ADD CONSTRAINT "book_lists_level_fk" FOREIGN KEY ("school_id","class_level_id") REFERENCES "public"."class_levels"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "school_isolation" ON "book_lists" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("book_lists"."school_id" = app_current_school_id()) WITH CHECK ("book_lists"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "book_lists" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');