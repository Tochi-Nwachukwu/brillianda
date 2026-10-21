CREATE TABLE "team_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_member_id" uuid,
	"team_member_name" text NOT NULL,
	"action" text NOT NULL,
	"summary" text NOT NULL,
	"about_school_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" "citext" NOT NULL,
	"full_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_members_email_unique" UNIQUE("email"),
	CONSTRAINT "team_members_email_shape" CHECK ("team_members"."email" ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);
--> statement-breakpoint
CREATE TABLE "team_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_member_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_sessions_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_name" text;--> statement-breakpoint
ALTER TABLE "team_log" ADD CONSTRAINT "team_log_team_member_id_team_members_id_fk" FOREIGN KEY ("team_member_id") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_log" ADD CONSTRAINT "team_log_about_school_id_schools_id_fk" FOREIGN KEY ("about_school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_sessions" ADD CONSTRAINT "team_sessions_team_member_id_team_members_id_fk" FOREIGN KEY ("team_member_id") REFERENCES "public"."team_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_log_created_idx" ON "team_log" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "team_log_school_idx" ON "team_log" USING btree ("about_school_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "team_sessions_member_idx" ON "team_sessions" USING btree ("team_member_id");--> statement-breakpoint
CREATE POLICY "platform_select" ON "academic_sessions" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_platform');--> statement-breakpoint
CREATE POLICY "platform_select" ON "class_arms" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_platform');--> statement-breakpoint
CREATE POLICY "platform_select" ON "class_level_subjects" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_platform');--> statement-breakpoint
CREATE POLICY "platform_select" ON "class_levels" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_platform');--> statement-breakpoint
CREATE POLICY "platform_select" ON "invitations" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_platform');--> statement-breakpoint
CREATE POLICY "platform_select" ON "school_subjects" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_platform');--> statement-breakpoint
CREATE POLICY "platform_select" ON "students" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_platform');