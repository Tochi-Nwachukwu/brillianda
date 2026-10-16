CREATE TYPE "public"."signup_status" AS ENUM('open', 'completed');--> statement-breakpoint
CREATE TABLE "signup_drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"status" "signup_status" DEFAULT 'open' NOT NULL,
	"school_name" text,
	"levels_offered" text[],
	"state" text,
	"school_phone" text,
	"owner_full_name" text,
	"owner_email" "citext",
	"owner_phone" text,
	"owner_password_hash" text,
	"email_verified_at" timestamp with time zone,
	"existing_user_id" uuid,
	"completed_school_id" uuid,
	"ip" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signup_drafts_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"email" "citext" NOT NULL,
	"role" "member_role" NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "invitations_tokenHash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invitations_school_id_id_key" UNIQUE("school_id","id")
);
--> statement-breakpoint
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "signup_drafts" ADD CONSTRAINT "signup_drafts_existing_user_id_users_id_fk" FOREIGN KEY ("existing_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signup_drafts" ADD CONSTRAINT "signup_drafts_completed_school_id_schools_id_fk" FOREIGN KEY ("completed_school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_user_id_users_id_fk" FOREIGN KEY ("accepted_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signup_drafts_expires_idx" ON "signup_drafts" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "signup_drafts_email_idx" ON "signup_drafts" USING btree ("owner_email");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_one_open_idx" ON "invitations" USING btree ("school_id","email") WHERE "invitations"."accepted_at" IS NULL AND "invitations"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "invitations_school_created_idx" ON "invitations" USING btree ("school_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "school_isolation" ON "invitations" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("invitations"."school_id" = app_current_school_id()) WITH CHECK ("invitations"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "invitations" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');