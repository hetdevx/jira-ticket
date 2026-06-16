"use strict";

require("dotenv").config();

const { App, ExpressReceiver } = require("@slack/bolt");
const { buildJiraAuthUrl, handleJiraCallback } = require("./jiraOAuth");
const { getJiraConnection, savePendingPreview, getPendingPreview, deletePendingPreview } =
  require("./db");
const { extractJiraFields } = require("./ai");
const { createJiraIssueForUser } = require("./jira");

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

const expressApp = receiver.app;

// ─── Health check ────────────────────────────────────────────────────────────

expressApp.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ─── Jira OAuth: start ───────────────────────────────────────────────────────

expressApp.get("/auth/jira/start", async (req, res) => {
  const { team_id, user_id } = req.query;

  if (!team_id || !user_id) {
    return res.status(400).send("Missing team_id or user_id");
  }

  try {
    const authUrl = await buildJiraAuthUrl({ slackTeamId: team_id, slackUserId: user_id });
    return res.redirect(authUrl);
  } catch (err) {
    console.error("[OAuth start error]", err.message);
    return res.status(500).send("Failed to start Jira OAuth. Please try again.");
  }
});

// ─── Jira OAuth: callback ────────────────────────────────────────────────────

expressApp.get("/auth/jira/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state) {
    return res.status(400).send("Missing code or state");
  }

  try {
    const html = await handleJiraCallback({ code, state });
    return res.send(html);
  } catch (err) {
    console.error("[OAuth callback error]", err.message);
    return res
      .status(400)
      .send(`<h2>Connection failed</h2><p>${err.message}</p><p>Please close this tab and try again from Slack.</p>`);
  }
});

// ─── /jira-ticket slash command ───────────────────────────────────────────────

app.command("/jira-ticket", async ({ command, ack, respond }) => {
  await ack();

  const { team_id, user_id, channel_id, text } = command;

  if (!text || !text.trim()) {
    await respond({
      response_type: "ephemeral",
      text: "Please provide a description.\n*Example:* `/jira-ticket Create high priority task to improve storefront SEO page titles. Project WEB.`",
    });
    return;
  }

  // Check Jira connection
  const connection = await getJiraConnection(team_id, user_id);
  if (!connection) {
    const connectUrl = `${process.env.APP_BASE_URL}/auth/jira/start?team_id=${team_id}&user_id=${user_id}`;
    await respond({
      response_type: "ephemeral",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: ":link: *Connect your Jira account to create tickets from Slack.*",
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Connect Jira", emoji: true },
              url: connectUrl,
              style: "primary",
              action_id: "connect_jira_link",
            },
          ],
        },
      ],
    });
    return;
  }

  // Extract fields with AI
  let fields;
  try {
    fields = await extractJiraFields(text.trim());
  } catch (err) {
    console.error("[AI extraction error]", err.message);
    await respond({
      response_type: "ephemeral",
      text: `:warning: Could not extract ticket fields: ${err.message}`,
    });
    return;
  }

  // Save pending preview (expires in 15 minutes)
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  const preview = await savePendingPreview({
    slackTeamId: team_id,
    slackUserId: user_id,
    slackChannelId: channel_id,
    originalText: text.trim(),
    extractedFields: fields,
    expiresAt,
  });

  await respond({
    response_type: "ephemeral",
    blocks: buildPreviewBlocks(fields, preview.id),
  });
});

// ─── create_jira_ticket action ────────────────────────────────────────────────

app.action("create_jira_ticket", async ({ action, body, ack, respond }) => {
  await ack();

  const previewId = action.value;
  const { team_id, user_id } = body;

  const preview = await getPendingPreview(previewId);

  if (!preview) {
    await respond({
      response_type: "ephemeral",
      replace_original: true,
      text: ":warning: This preview has expired. Please run `/jira-ticket` again.",
    });
    return;
  }

  if (preview.slackTeamId !== team_id || preview.slackUserId !== user_id) {
    await respond({
      response_type: "ephemeral",
      replace_original: true,
      text: ":no_entry: You are not authorized to create this ticket.",
    });
    return;
  }

  if (new Date() > preview.expiresAt) {
    await deletePendingPreview(previewId);
    await respond({
      response_type: "ephemeral",
      replace_original: true,
      text: ":warning: This preview has expired. Please run `/jira-ticket` again.",
    });
    return;
  }

  let issue;
  try {
    issue = await createJiraIssueForUser({
      slackTeamId: team_id,
      slackUserId: user_id,
      fields: preview.extractedFields,
    });
  } catch (err) {
    console.error("[Jira create error]", err.message);
    await respond({
      response_type: "ephemeral",
      replace_original: true,
      text: `:warning: Failed to create Jira ticket: ${err.message}`,
    });
    return;
  }

  await deletePendingPreview(previewId);

  await respond({
    response_type: "ephemeral",
    replace_original: true,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:white_check_mark: *Jira ticket created!*\n*<${issue.url}|${issue.key}>* — ${preview.extractedFields.summary}`,
        },
      },
    ],
  });
});

// ─── cancel_jira_ticket action ────────────────────────────────────────────────

app.action("cancel_jira_ticket", async ({ action, ack, respond }) => {
  await ack();

  const previewId = action.value;
  await deletePendingPreview(previewId);

  await respond({
    response_type: "ephemeral",
    replace_original: true,
    text: ":x: Ticket creation cancelled.",
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildPreviewBlocks(fields, previewId) {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Jira Ticket Preview", emoji: true },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Summary:*\n${fields.summary}` },
        { type: "mrkdwn", text: `*Project:*\n${fields.projectKey}` },
        { type: "mrkdwn", text: `*Priority:*\n${fields.priority}` },
        { type: "mrkdwn", text: `*Issue Type:*\n${fields.issueType}` },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Description:*\n${fields.description}` },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Create Jira Ticket", emoji: true },
          style: "primary",
          action_id: "create_jira_ticket",
          value: previewId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Cancel", emoji: true },
          style: "danger",
          action_id: "cancel_jira_ticket",
          value: previewId,
        },
      ],
    },
  ];
}

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

(async () => {
  await app.start(PORT);
  console.log(`⚡ slack-jira-ticket-bot running on port ${PORT}`);
})();
