-- CreateTable
CREATE TABLE "jira_connections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slack_team_id" TEXT NOT NULL,
    "slack_user_id" TEXT NOT NULL,
    "atlassian_account_id" TEXT,
    "atlassian_email" TEXT,
    "cloud_id" TEXT NOT NULL,
    "cloud_name" TEXT,
    "cloud_url" TEXT NOT NULL,
    "encrypted_access_token" TEXT NOT NULL,
    "encrypted_refresh_token" TEXT NOT NULL,
    "token_expires_at" TIMESTAMPTZ NOT NULL,
    "scopes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "jira_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_states" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "state" TEXT NOT NULL,
    "slack_team_id" TEXT NOT NULL,
    "slack_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_ticket_previews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slack_team_id" TEXT NOT NULL,
    "slack_user_id" TEXT NOT NULL,
    "slack_channel_id" TEXT,
    "original_text" TEXT NOT NULL,
    "extracted_fields" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "pending_ticket_previews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "jira_connections_slack_team_id_slack_user_id_key" ON "jira_connections"("slack_team_id", "slack_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_states_state_key" ON "oauth_states"("state");

-- CreateIndex
CREATE INDEX "oauth_states_state_idx" ON "oauth_states"("state");

-- CreateIndex
CREATE INDEX "pending_ticket_previews_slack_team_id_slack_user_id_idx" ON "pending_ticket_previews"("slack_team_id", "slack_user_id");
