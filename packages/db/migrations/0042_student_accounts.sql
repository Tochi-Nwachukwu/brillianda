ALTER TYPE "public"."member_role" ADD VALUE 'student';--> statement-breakpoint
CREATE TABLE "student_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "student_links_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "student_links_student_key" UNIQUE("school_id","student_id"),
	CONSTRAINT "student_links_user_key" UNIQUE("school_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "student_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "student_id" uuid;--> statement-breakpoint
ALTER TABLE "student_links" ADD CONSTRAINT "student_links_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_links" ADD CONSTRAINT "student_links_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."students"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_links" ADD CONSTRAINT "student_links_member_fk" FOREIGN KEY ("school_id","user_id") REFERENCES "public"."school_members"("school_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invitations_school_student_idx" ON "invitations" USING btree ("school_id","student_id");--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_student_record_check" CHECK (("invitations"."role"::text = 'student') = ("invitations"."student_id" IS NOT NULL));--> statement-breakpoint
CREATE POLICY "school_isolation" ON "student_links" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("student_links"."school_id" = app_current_school_id()) WITH CHECK ("student_links"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "student_links" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');