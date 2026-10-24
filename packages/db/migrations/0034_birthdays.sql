CREATE TYPE "public"."birthday_text_status" AS ENUM('pending', 'sent', 'no_phone', 'failed');--> statement-breakpoint
CREATE TABLE "birthday_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "birthday_settings_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "birthday_settings_one_per_school_key" UNIQUE("school_id"),
	CONSTRAINT "birthday_settings_message_length" CHECK (char_length("birthday_settings"."message") BETWEEN 10 AND 300)
);
--> statement-breakpoint
ALTER TABLE "birthday_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "birthday_texts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"day" date NOT NULL,
	"phone" text,
	"text" text NOT NULL,
	"status" "birthday_text_status" NOT NULL,
	"provider_ref" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "birthday_texts_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "birthday_texts_once_key" UNIQUE("school_id","student_id","day")
);
--> statement-breakpoint
ALTER TABLE "birthday_texts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "birthday_settings" ADD CONSTRAINT "birthday_settings_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "birthday_texts" ADD CONSTRAINT "birthday_texts_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "birthday_texts" ADD CONSTRAINT "birthday_texts_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."students"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "birthday_texts_school_created_idx" ON "birthday_texts" USING btree ("school_id","created_at");--> statement-breakpoint
CREATE POLICY "school_isolation" ON "birthday_settings" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("birthday_settings"."school_id" = app_current_school_id()) WITH CHECK ("birthday_settings"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "birthday_settings" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');--> statement-breakpoint
CREATE POLICY "platform_select" ON "birthday_settings" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_platform');--> statement-breakpoint
CREATE POLICY "school_isolation" ON "birthday_texts" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("birthday_texts"."school_id" = app_current_school_id()) WITH CHECK ("birthday_texts"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "birthday_texts" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');