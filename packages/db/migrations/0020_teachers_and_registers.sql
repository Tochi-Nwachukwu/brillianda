CREATE TYPE "public"."register_mark" AS ENUM('present', 'late', 'absent');--> statement-breakpoint
ALTER TYPE "public"."member_role" ADD VALUE 'teacher';--> statement-breakpoint
CREATE TABLE "arm_form_teachers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"class_arm_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "arm_form_teachers_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "arm_form_teachers_one_per_arm_key" UNIQUE("school_id","class_arm_id")
);
--> statement-breakpoint
ALTER TABLE "arm_form_teachers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "register_marks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"mark" "register_mark" NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "register_marks_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "register_marks_one_per_student_key" UNIQUE("school_id","register_id","student_id"),
	CONSTRAINT "register_marks_note_length_check" CHECK (char_length("register_marks"."note") <= 120)
);
--> statement-breakpoint
ALTER TABLE "register_marks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "registers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"class_arm_id" uuid NOT NULL,
	"day" date NOT NULL,
	"taken_by" uuid,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" uuid,
	"changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "registers_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "registers_arm_day_key" UNIQUE("school_id","class_arm_id","day")
);
--> statement-breakpoint
ALTER TABLE "registers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "subject_teachers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"class_arm_id" uuid NOT NULL,
	"school_subject_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "subject_teachers_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "subject_teachers_one_per_class_key" UNIQUE("school_id","class_arm_id","school_subject_id")
);
--> statement-breakpoint
ALTER TABLE "subject_teachers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "arm_form_teachers" ADD CONSTRAINT "arm_form_teachers_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arm_form_teachers" ADD CONSTRAINT "arm_form_teachers_arm_fk" FOREIGN KEY ("school_id","class_arm_id") REFERENCES "public"."class_arms"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arm_form_teachers" ADD CONSTRAINT "arm_form_teachers_member_fk" FOREIGN KEY ("school_id","user_id") REFERENCES "public"."school_members"("school_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_marks" ADD CONSTRAINT "register_marks_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_marks" ADD CONSTRAINT "register_marks_register_fk" FOREIGN KEY ("school_id","register_id") REFERENCES "public"."registers"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_marks" ADD CONSTRAINT "register_marks_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."students"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registers" ADD CONSTRAINT "registers_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registers" ADD CONSTRAINT "registers_taken_by_users_id_fk" FOREIGN KEY ("taken_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registers" ADD CONSTRAINT "registers_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registers" ADD CONSTRAINT "registers_arm_fk" FOREIGN KEY ("school_id","class_arm_id") REFERENCES "public"."class_arms"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_teachers" ADD CONSTRAINT "subject_teachers_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_teachers" ADD CONSTRAINT "subject_teachers_arm_fk" FOREIGN KEY ("school_id","class_arm_id") REFERENCES "public"."class_arms"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_teachers" ADD CONSTRAINT "subject_teachers_subject_fk" FOREIGN KEY ("school_id","school_subject_id") REFERENCES "public"."school_subjects"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_teachers" ADD CONSTRAINT "subject_teachers_member_fk" FOREIGN KEY ("school_id","user_id") REFERENCES "public"."school_members"("school_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "arm_form_teachers_user_idx" ON "arm_form_teachers" USING btree ("school_id","user_id");--> statement-breakpoint
CREATE INDEX "register_marks_student_idx" ON "register_marks" USING btree ("school_id","student_id");--> statement-breakpoint
CREATE INDEX "registers_school_day_idx" ON "registers" USING btree ("school_id","day");--> statement-breakpoint
CREATE INDEX "subject_teachers_user_idx" ON "subject_teachers" USING btree ("school_id","user_id");--> statement-breakpoint
CREATE POLICY "school_isolation" ON "arm_form_teachers" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("arm_form_teachers"."school_id" = app_current_school_id()) WITH CHECK ("arm_form_teachers"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "arm_form_teachers" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');--> statement-breakpoint
CREATE POLICY "school_isolation" ON "register_marks" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("register_marks"."school_id" = app_current_school_id()) WITH CHECK ("register_marks"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "register_marks" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');--> statement-breakpoint
CREATE POLICY "school_isolation" ON "registers" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("registers"."school_id" = app_current_school_id()) WITH CHECK ("registers"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "registers" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');--> statement-breakpoint
CREATE POLICY "school_isolation" ON "subject_teachers" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("subject_teachers"."school_id" = app_current_school_id()) WITH CHECK ("subject_teachers"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "subject_teachers" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');