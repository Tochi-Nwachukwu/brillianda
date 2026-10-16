ALTER TYPE "public"."member_role" ADD VALUE 'parent';--> statement-breakpoint
CREATE TABLE "parent_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"guardian_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "parent_links_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "parent_links_pair_key" UNIQUE("school_id","guardian_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "parent_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "guardian_id" uuid;--> statement-breakpoint
ALTER TABLE "parent_links" ADD CONSTRAINT "parent_links_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_links" ADD CONSTRAINT "parent_links_guardian_fk" FOREIGN KEY ("school_id","guardian_id") REFERENCES "public"."guardians"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_links" ADD CONSTRAINT "parent_links_member_fk" FOREIGN KEY ("school_id","user_id") REFERENCES "public"."school_members"("school_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "parent_links_user_idx" ON "parent_links" USING btree ("school_id","user_id");--> statement-breakpoint
CREATE INDEX "invitations_school_guardian_idx" ON "invitations" USING btree ("school_id","guardian_id");--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_parent_guardian_check" CHECK (("invitations"."role"::text = 'parent') = ("invitations"."guardian_id" IS NOT NULL));--> statement-breakpoint
CREATE POLICY "school_isolation" ON "parent_links" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("parent_links"."school_id" = app_current_school_id()) WITH CHECK ("parent_links"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "parent_links" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');