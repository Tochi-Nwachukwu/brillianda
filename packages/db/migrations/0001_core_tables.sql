CREATE TYPE "public"."school_status" AS ENUM('active', 'suspended', 'archived');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."verification_purpose" AS ENUM('email_verification', 'password_reset', 'magic_link', 'handover', 'email_change');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin');--> statement-breakpoint
CREATE TYPE "public"."member_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TABLE "schools" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"subdomain" "citext" NOT NULL,
	"status" "school_status" DEFAULT 'active' NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"levels_offered" text[] DEFAULT '{}'::text[] NOT NULL,
	"state" text,
	"phone" text,
	"logo_key" text,
	"brand_color" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schools_subdomain_unique" UNIQUE("subdomain"),
	CONSTRAINT "schools_subdomain_shape" CHECK ("schools"."subdomain"::text ~ '^[a-z][a-z0-9-]{1,28}[a-z0-9]$' AND "schools"."subdomain"::text !~ '--'),
	CONSTRAINT "schools_brand_color_hex" CHECK ("schools"."brand_color" IS NULL OR "schools"."brand_color" ~ '^#[0-9a-fA-F]{6}$')
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" "citext" NOT NULL,
	"email_verified_at" timestamp with time zone,
	"password_hash" text,
	"full_name" text NOT NULL,
	"phone" text,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_email_shape" CHECK ("users"."email" ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"purpose" "verification_purpose" NOT NULL,
	"identifier" "citext" NOT NULL,
	"user_id" uuid,
	"token_hash" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_tokens_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid,
	"changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_school_id_id_key" UNIQUE("school_id","id")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "school_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" NOT NULL,
	"status" "member_status" DEFAULT 'active' NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "school_members_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "school_members_school_user_key" UNIQUE("school_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "school_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"ip" text,
	"user_agent" text,
	CONSTRAINT "sessions_tokenHash_unique" UNIQUE("token_hash"),
	CONSTRAINT "sessions_school_id_id_key" UNIQUE("school_id","id")
);
--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "schools" ADD CONSTRAINT "schools_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_tokens" ADD CONSTRAINT "verification_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_members" ADD CONSTRAINT "school_members_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_members" ADD CONSTRAINT "school_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_members" ADD CONSTRAINT "school_members_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_membership_fk" FOREIGN KEY ("school_id","user_id") REFERENCES "public"."school_members"("school_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "verification_tokens_open_idx" ON "verification_tokens" USING btree ("purpose","identifier","created_at") WHERE "verification_tokens"."consumed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "verification_tokens_expires_idx" ON "verification_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "audit_log_school_created_idx" ON "audit_log" USING btree ("school_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_school_entity_idx" ON "audit_log" USING btree ("school_id","entity","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "school_members_one_owner_idx" ON "school_members" USING btree ("school_id") WHERE "school_members"."role" = 'owner';--> statement-breakpoint
CREATE INDEX "school_members_user_idx" ON "school_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_school_user_idx" ON "sessions" USING btree ("school_id","user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE POLICY "school_isolation" ON "audit_log" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("audit_log"."school_id" = app_current_school_id()) WITH CHECK ("audit_log"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "school_isolation" ON "school_members" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("school_members"."school_id" = app_current_school_id()) WITH CHECK ("school_members"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "platform_select" ON "school_members" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_platform');--> statement-breakpoint
CREATE POLICY "school_isolation" ON "sessions" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("sessions"."school_id" = app_current_school_id()) WITH CHECK ("sessions"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "platform_select" ON "sessions" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_platform');--> statement-breakpoint
CREATE POLICY "platform_delete" ON "sessions" AS PERMISSIVE FOR DELETE TO public USING (current_user = 'brillianda_platform');