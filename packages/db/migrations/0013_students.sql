CREATE TYPE "public"."gender" AS ENUM('male', 'female');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('completed', 'undone');--> statement-breakpoint
CREATE TYPE "public"."student_status" AS ENUM('active', 'suspended', 'withdrawn', 'transferred', 'graduated');--> statement-breakpoint
CREATE TABLE "counters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"name" text NOT NULL,
	"next_value" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "counters_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "counters_school_name_key" UNIQUE("school_id","name")
);
--> statement-breakpoint
ALTER TABLE "counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "enrolments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"class_arm_id" uuid NOT NULL,
	"session_id" uuid,
	"started_on" date NOT NULL,
	"ended_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "enrolments_school_id_id_key" UNIQUE("school_id","id")
);
--> statement-breakpoint
ALTER TABLE "enrolments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "guardians" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"phone" text,
	"email" "citext",
	"address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "guardians_school_id_id_key" UNIQUE("school_id","id")
);
--> statement-breakpoint
ALTER TABLE "guardians" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"row_count" integer NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "import_status" DEFAULT 'completed' NOT NULL,
	"undone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "import_batches_school_id_id_key" UNIQUE("school_id","id")
);
--> statement-breakpoint
ALTER TABLE "import_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "student_guardians" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"guardian_id" uuid NOT NULL,
	"relationship" text,
	"primary_contact" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "student_guardians_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "student_guardians_pair_key" UNIQUE("school_id","student_id","guardian_id")
);
--> statement-breakpoint
ALTER TABLE "student_guardians" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "students" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"admission_number" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"other_names" text DEFAULT '' NOT NULL,
	"gender" "gender" NOT NULL,
	"date_of_birth" date,
	"admission_date" date NOT NULL,
	"status" "student_status" DEFAULT 'active' NOT NULL,
	"class_arm_id" uuid NOT NULL,
	"photo_key" text,
	"address" text DEFAULT '' NOT NULL,
	"state_of_origin" text DEFAULT '' NOT NULL,
	"consent_recorded_on" date,
	"import_batch_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "students_school_id_id_key" UNIQUE("school_id","id")
);
--> statement-breakpoint
ALTER TABLE "students" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "counters" ADD CONSTRAINT "counters_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."students"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_class_arm_fk" FOREIGN KEY ("school_id","class_arm_id") REFERENCES "public"."class_arms"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_session_fk" FOREIGN KEY ("school_id","session_id") REFERENCES "public"."academic_sessions"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_guardians" ADD CONSTRAINT "student_guardians_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_guardians" ADD CONSTRAINT "student_guardians_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."students"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_guardians" ADD CONSTRAINT "student_guardians_guardian_fk" FOREIGN KEY ("school_id","guardian_id") REFERENCES "public"."guardians"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_class_arm_fk" FOREIGN KEY ("school_id","class_arm_id") REFERENCES "public"."class_arms"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_import_batch_fk" FOREIGN KEY ("school_id","import_batch_id") REFERENCES "public"."import_batches"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "enrolments_school_student_idx" ON "enrolments" USING btree ("school_id","student_id");--> statement-breakpoint
CREATE INDEX "enrolments_school_class_arm_idx" ON "enrolments" USING btree ("school_id","class_arm_id");--> statement-breakpoint
CREATE INDEX "guardians_school_phone_idx" ON "guardians" USING btree ("school_id","phone");--> statement-breakpoint
CREATE INDEX "import_batches_school_created_idx" ON "import_batches" USING btree ("school_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "student_guardians_guardian_idx" ON "student_guardians" USING btree ("school_id","guardian_id");--> statement-breakpoint
CREATE UNIQUE INDEX "students_school_admission_idx" ON "students" USING btree ("school_id",lower("admission_number")) WHERE "students"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "students_school_class_arm_idx" ON "students" USING btree ("school_id","class_arm_id");--> statement-breakpoint
CREATE INDEX "students_school_batch_idx" ON "students" USING btree ("school_id","import_batch_id");--> statement-breakpoint
CREATE INDEX "students_school_name_trgm_idx" ON "students" USING gin (app_unaccent("first_name" || ' ' || "other_names" || ' ' || "last_name") gin_trgm_ops);--> statement-breakpoint
CREATE POLICY "school_isolation" ON "counters" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("counters"."school_id" = app_current_school_id()) WITH CHECK ("counters"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "counters" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');--> statement-breakpoint
CREATE POLICY "school_isolation" ON "enrolments" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("enrolments"."school_id" = app_current_school_id()) WITH CHECK ("enrolments"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "enrolments" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');--> statement-breakpoint
CREATE POLICY "school_isolation" ON "guardians" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("guardians"."school_id" = app_current_school_id()) WITH CHECK ("guardians"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "guardians" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');--> statement-breakpoint
CREATE POLICY "school_isolation" ON "import_batches" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("import_batches"."school_id" = app_current_school_id()) WITH CHECK ("import_batches"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "import_batches" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');--> statement-breakpoint
CREATE POLICY "school_isolation" ON "student_guardians" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("student_guardians"."school_id" = app_current_school_id()) WITH CHECK ("student_guardians"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "student_guardians" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');--> statement-breakpoint
CREATE POLICY "school_isolation" ON "students" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("students"."school_id" = app_current_school_id()) WITH CHECK ("students"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "students" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');