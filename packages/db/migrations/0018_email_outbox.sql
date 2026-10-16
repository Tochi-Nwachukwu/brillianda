CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"to" "citext" NOT NULL,
	"tag" text NOT NULL,
	"subject" text NOT NULL,
	"text" text NOT NULL,
	"html" text NOT NULL,
	"delivered" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "email_outbox_to_created_idx" ON "email_outbox" USING btree ("to","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "email_outbox_created_idx" ON "email_outbox" USING btree ("created_at");