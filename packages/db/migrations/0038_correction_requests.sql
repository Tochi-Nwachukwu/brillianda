CREATE TYPE "public"."correction_status" AS ENUM('open', 'approved', 'declined');--> statement-breakpoint
CREATE TABLE "correction_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"guardian_id" uuid NOT NULL,
	"requested_by" uuid,
	"changes" jsonb NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"status" "correction_status" DEFAULT 'open' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decline_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "correction_requests_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "correction_requests_note_length" CHECK (char_length("correction_requests"."note") <= 300),
	CONSTRAINT "correction_requests_reason_length" CHECK ("correction_requests"."decline_reason" IS NULL OR char_length("correction_requests"."decline_reason") BETWEEN 3 AND 200)
);
--> statement-breakpoint
ALTER TABLE "correction_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "correction_requests" ADD CONSTRAINT "correction_requests_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_requests" ADD CONSTRAINT "correction_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_requests" ADD CONSTRAINT "correction_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_requests" ADD CONSTRAINT "correction_requests_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."students"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_requests" ADD CONSTRAINT "correction_requests_guardian_fk" FOREIGN KEY ("school_id","guardian_id") REFERENCES "public"."guardians"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "correction_requests_school_status_idx" ON "correction_requests" USING btree ("school_id","status","created_at");--> statement-breakpoint
CREATE INDEX "correction_requests_school_student_idx" ON "correction_requests" USING btree ("school_id","student_id");--> statement-breakpoint
CREATE POLICY "school_isolation" ON "correction_requests" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("correction_requests"."school_id" = app_current_school_id()) WITH CHECK ("correction_requests"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "correction_requests" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');