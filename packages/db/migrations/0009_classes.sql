CREATE TYPE "public"."class_section" AS ENUM('preschool', 'primary', 'junior', 'senior');--> statement-breakpoint
CREATE TYPE "public"."department" AS ENUM('science', 'arts', 'commercial');--> statement-breakpoint
CREATE TABLE "arms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "arms_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "arms_school_code_key" UNIQUE("school_id","code")
);
--> statement-breakpoint
ALTER TABLE "arms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "class_arms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"class_level_id" uuid NOT NULL,
	"arm_id" uuid NOT NULL,
	"department" "department",
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "class_arms_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "class_arms_level_arm_key" UNIQUE("school_id","class_level_id","arm_id")
);
--> statement-breakpoint
ALTER TABLE "class_arms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "class_levels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"key" text,
	"name" text NOT NULL,
	"short_name" text NOT NULL,
	"section" "class_section" NOT NULL,
	"position" integer NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "class_levels_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "class_levels_school_position_key" UNIQUE("school_id","position")
);
--> statement-breakpoint
ALTER TABLE "class_levels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "arms" ADD CONSTRAINT "arms_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_arms" ADD CONSTRAINT "class_arms_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_arms" ADD CONSTRAINT "class_arms_level_fk" FOREIGN KEY ("school_id","class_level_id") REFERENCES "public"."class_levels"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_arms" ADD CONSTRAINT "class_arms_arm_fk" FOREIGN KEY ("school_id","arm_id") REFERENCES "public"."arms"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_levels" ADD CONSTRAINT "class_levels_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "arms_school_name_idx" ON "arms" USING btree ("school_id",lower("name"));--> statement-breakpoint
CREATE INDEX "class_arms_school_arm_idx" ON "class_arms" USING btree ("school_id","arm_id");--> statement-breakpoint
CREATE UNIQUE INDEX "class_levels_school_name_idx" ON "class_levels" USING btree ("school_id",lower("name"));--> statement-breakpoint
CREATE POLICY "school_isolation" ON "arms" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("arms"."school_id" = app_current_school_id()) WITH CHECK ("arms"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "arms" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');--> statement-breakpoint
CREATE POLICY "school_isolation" ON "class_arms" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("class_arms"."school_id" = app_current_school_id()) WITH CHECK ("class_arms"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "class_arms" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');--> statement-breakpoint
CREATE POLICY "school_isolation" ON "class_levels" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("class_levels"."school_id" = app_current_school_id()) WITH CHECK ("class_levels"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "class_levels" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');