CREATE TYPE "public"."trial_status" AS ENUM('new', 'contacted', 'converted', 'declined');--> statement-breakpoint
CREATE TABLE "trial_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_name" text NOT NULL,
	"contact_name" text NOT NULL,
	"role" text NOT NULL,
	"email" "citext" NOT NULL,
	"phone" text NOT NULL,
	"student_count" integer NOT NULL,
	"state" text,
	"interests" text[] DEFAULT '{}'::text[] NOT NULL,
	"message" text,
	"status" "trial_status" DEFAULT 'new' NOT NULL,
	"team_note" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "school_logos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"content_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"sha256" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "school_logos_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "school_logos_one_per_school_key" UNIQUE("school_id")
);
--> statement-breakpoint
ALTER TABLE "school_logos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "school_logos" ADD CONSTRAINT "school_logos_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trial_requests_created_idx" ON "trial_requests" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "trial_requests_status_idx" ON "trial_requests" USING btree ("status");--> statement-breakpoint
CREATE POLICY "school_isolation" ON "school_logos" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("school_logos"."school_id" = app_current_school_id()) WITH CHECK ("school_logos"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "school_logos" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');