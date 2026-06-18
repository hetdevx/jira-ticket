"use strict";

require("dotenv").config();

const crypto = require("crypto");
const { App, ExpressReceiver } = require("@slack/bolt");
const axios = require("axios");
const { buildJiraAuthUrl, handleJiraCallback } = require("./jiraOAuth");
const {
  getJiraConnection,
  savePendingPreview,
  getPendingPreview,
  deletePendingPreview,
  deleteJiraConnection,
  updatePendingPreviewFields,
} = require("./db");
const { extractJiraFields } = require("./ai");
const { createJiraIssueForUser, getJiraProjects, getJiraAssignableUsers, getJiraProjectIssueTypes } = require("./jira");

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  customPropertiesExtractor: (req) => {
    console.log("[Slack request]", {
      path: req.path,
      type: req.body?.type || req.body?.command || req.body?.payload?.type,
      event: req.body?.event?.type,
    });
    return {};
  },
  processEventErrorHandler: async ({ error, body }) => {
    console.error("[Slack event processing error]", {
      error: error.message,
      type: body?.type,
      event: body?.event?.type,
    });
    return true;
  },
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
  const { token } = req.query;

  if (!token) {
    return res.status(400).send("Missing connect token");
  }

  try {
    const { slackTeamId, slackUserId } = verifyConnectToken(token);
    const authUrl = await buildJiraAuthUrl({ slackTeamId, slackUserId });
    return res.redirect(authUrl);
  } catch (err) {
    console.error("[OAuth start error]", err.message);
    return res.status(400).send("Failed to start Jira OAuth. Please try again from Slack.");
  }
});

// ─── Jira OAuth: callback ────────────────────────────────────────────────────

expressApp.get("/auth/jira/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state) {
    return res.status(400).send("Missing code or state");
  }

  try {
    const { html, slackUserId, cloudName } = await handleJiraCallback({ code, state });

    // Send a DM to the user in Slack notifying them of successful connection
    try {
      const dm = await app.client.conversations.open({ users: slackUserId });
      await app.client.chat.postMessage({
        channel: dm.channel.id,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `:white_check_mark: *You're connected to Jira!*\n\nYour account has been linked to *${cloudName}*. You can now create tickets directly from Slack.\n\nRun \`/jira-ticket <your request>\` or mention me in a channel to get started.`,
            },
          },
        ],
        text: `You're now connected to Jira (${cloudName}). Run /jira-ticket or mention the bot to create tickets.`,
      });
    } catch (dmErr) {
      console.error("[Slack DM error]", dmErr.message);
    }

    return res.send(html);
  } catch (err) {
    console.error("[OAuth callback error]", err.message);
    return res
      .status(400)
      .send(`<h2>Connection failed</h2><p>${escapeHtml(err.message)}</p><p>Please close this tab and try again from Slack.</p>`);
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

  await createTicketPreview({
    slackTeamId: team_id,
    slackUserId: user_id,
    slackChannelId: channel_id,
    inputText: text.trim(),
    respond,
  });
});

// ─── app mention: @Jira Ticket Bot create ... ───────────────────────────────

app.event("app_mention", async ({ event, body, client }) => {
  const slackTeamId = body.team_id || event.team;
  const slackUserId = event.user;
  const slackChannelId = event.channel;
  const promptText = stripSlackMentions(event.text);
  const threadTs = event.thread_ts || event.ts;

  console.log("[Slack app_mention]", {
    team: slackTeamId,
    channel: slackChannelId,
    user: slackUserId,
    ts: event.ts,
    hasThread: Boolean(event.thread_ts),
  });

  if (!promptText) {
    await safePostEphemeral(client, {
      channel: slackChannelId,
      user: slackUserId,
      thread_ts: threadTs,
      text: "Please include the ticket details after mentioning me.",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Please include the ticket details after mentioning me.\n*Example:* `@Jira Ticket Bot create high priority task to improve storefront SEO page titles. Project WEB.`",
          },
        },
      ],
    });
    return;
  }

  await safePostMessage(client, {
    channel: slackChannelId,
    thread_ts: threadTs,
    text: "I’m preparing a Jira ticket preview for you.",
  });

  const threadContext = await getMentionThreadContext({ client, event });
  const inputText = threadContext
    ? `${promptText}\n\nSlack thread context:\n${threadContext}`
    : promptText;

  await createTicketPreview({
    slackTeamId,
    slackUserId,
    slackChannelId,
    inputText,
    displayText: promptText,
    respond: (message) =>
      safePostEphemeral(client, {
        channel: slackChannelId,
        user: slackUserId,
        thread_ts: threadTs,
        text: message.text || "Jira ticket preview",
        blocks: message.blocks,
      }),
  });
});

// ─── connect_jira_link action (URL button — just ack) ────────────────────────

app.action("connect_jira_link", async ({ ack }) => {
  await ack();
});

// ─── /jira-disconnect slash command ──────────────────────────────────────────

app.command("/jira-disconnect", async ({ command, ack, respond }) => {
  await ack();

  const { team_id, user_id } = command;
  const connection = await getJiraConnection(team_id, user_id);

  if (!connection) {
    await respond({
      response_type: "ephemeral",
      text: ":information_source: You don't have a Jira account connected.",
    });
    return;
  }

  await deleteJiraConnection(team_id, user_id);

  await respond({
    response_type: "ephemeral",
    text: `:white_check_mark: Your Jira account (*${connection.cloudName || connection.cloudUrl}*) has been disconnected. Run \`/jira-ticket\` anytime to reconnect.`,
  });
});

// ─── create_jira_ticket action ────────────────────────────────────────────────

app.action("create_jira_ticket", async ({ action, body, ack, respond }) => {
  await ack();

  const previewId = action.value;
  const team_id = body.team?.id || body.team_id;
  const user_id = body.user?.id || body.user_id;

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

  const state = body.state?.values || {};
  const selectedProjectKey = state.project_block?.select_project?.selected_option?.value;
  const selectedPriority = state.priority_block?.select_priority?.selected_option?.value;
  const selectedIssueType = state.issuetype_block?.select_issuetype?.selected_option?.value;
  const selectedAssignee = state.assignee_block?.select_assignee?.selected_option?.value;
  const selectedDuedate = state.duedate_block?.select_duedate?.selected_date || null;

  if (!selectedProjectKey) {
    await respond({
      response_type: "ephemeral",
      replace_original: false,
      text: ":point_up: Please select a project before creating the ticket.",
    });
    return;
  }

  // Re-read preview to get latest extractedFields (may have been updated via modal)
  const latestPreview = await getPendingPreview(previewId);

  let issue;
  try {
    issue = await createJiraIssueForUser({
      slackTeamId: team_id,
      slackUserId: user_id,
      fields: {
        ...latestPreview.extractedFields,
        projectKey: selectedProjectKey,
        ...(selectedPriority && { priority: selectedPriority }),
        ...(selectedIssueType && { issueType: selectedIssueType }),
        ...(selectedAssignee && selectedAssignee !== "unassigned" && { assigneeAccountId: selectedAssignee }),
        ...(selectedDuedate && { duedate: selectedDuedate }),
      },
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
          text: `:white_check_mark: *Jira ticket created!*\n*<${issue.url}|${issue.key}>* — ${latestPreview.extractedFields.summary}`,
        },
      },
    ],
  });
});

// ─── select_project action ────────────────────────────────────────────────────

app.action("select_project", async ({ action, body, ack, respond }) => {
  await ack();

  const projectKey = action.selected_option.value;
  const team_id = body.team?.id || body.team_id;
  const user_id = body.user?.id || body.user_id;

  // Find the previewId from the actions block button value
  let previewId = null;
  const blocks = body.message?.blocks || [];
  for (const block of blocks) {
    if (block.type === "actions" && Array.isArray(block.elements)) {
      const btn = block.elements.find((el) => el.action_id === "create_jira_ticket");
      if (btn) {
        previewId = btn.value;
        break;
      }
    }
  }

  if (!previewId) return;

  const preview = await getPendingPreview(previewId);
  if (!preview) return;

  const connection = await getJiraConnection(team_id, user_id);
  if (!connection) return;

  const [projects, assignees, issueTypes] = await Promise.all([
    getJiraProjects(connection),
    getJiraAssignableUsers(connection, projectKey),
    getJiraProjectIssueTypes(connection, projectKey),
  ]);

  const stateValues = body.state?.values || {};
  const currentPriority = stateValues.priority_block?.select_priority?.selected_option?.value;

  // Reset issueType since new project may not support the previous selection
  const currentFields = {
    ...preview.extractedFields,
    ...(currentPriority && { priority: currentPriority }),
    issueType: issueTypes.length > 0 ? issueTypes[0].name : preview.extractedFields.issueType,
  };

  await respond({
    response_type: "ephemeral",
    replace_original: true,
    blocks: buildPreviewBlocks(currentFields, previewId, projects, assignees, issueTypes, projectKey, null, null, preview.originalText),
  });
});

// ─── select_priority action (dropdown change — just ack) ─────────────────────

app.action("select_priority", async ({ ack }) => {
  await ack();
});

// ─── select_issuetype action (dropdown change — just ack) ────────────────────

app.action("select_issuetype", async ({ ack }) => {
  await ack();
});

// ─── select_assignee action (dropdown change — just ack) ─────────────────────

app.action("select_assignee", async ({ ack }) => {
  await ack();
});

// ─── select_duedate action (datepicker — just ack) ───────────────────────────

app.action("select_duedate", async ({ ack }) => {
  await ack();
});

// ─── edit_ticket_details action ───────────────────────────────────────────────

app.action("edit_ticket_details", async ({ action, body, ack, client }) => {
  await ack();

  const previewId = action.value;
  const preview = await getPendingPreview(previewId);
  if (!preview) return;

  const state = body.state?.values || {};
  const selectedProjectKey = state.project_block?.select_project?.selected_option?.value || null;
  const selectedPriority = state.priority_block?.select_priority?.selected_option?.value || null;
  const selectedIssueType = state.issuetype_block?.select_issuetype?.selected_option?.value || null;
  const selectedAssignee = state.assignee_block?.select_assignee?.selected_option?.value || null;
  const selectedDuedate = state.duedate_block?.select_duedate?.selected_date || null;

  const metadata = JSON.stringify({ previewId, responseUrl: body.response_url, selectedProjectKey, selectedPriority, selectedIssueType, selectedAssignee, selectedDuedate });

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal",
      callback_id: "edit_ticket_modal",
      private_metadata: metadata,
      title: { type: "plain_text", text: "Edit Ticket Details" },
      submit: { type: "plain_text", text: "Save" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "input",
          block_id: "summary_block",
          label: { type: "plain_text", text: "Summary" },
          element: {
            type: "plain_text_input",
            action_id: "summary_input",
            initial_value: preview.extractedFields.summary,
            max_length: 255,
          },
        },
        {
          type: "input",
          block_id: "description_block",
          label: { type: "plain_text", text: "Description" },
          element: {
            type: "plain_text_input",
            action_id: "description_input",
            initial_value: preview.extractedFields.description,
            multiline: true,
          },
        },
      ],
    },
  });
});

// ─── edit_ticket_modal view submission ────────────────────────────────────────

app.view("edit_ticket_modal", async ({ view, ack, body }) => {
  await ack();

  const { previewId, responseUrl, selectedProjectKey, selectedPriority, selectedIssueType, selectedAssignee, selectedDuedate } = JSON.parse(view.private_metadata);
  const summary = view.state.values.summary_block.summary_input.value;
  const description = view.state.values.description_block.description_input.value;

  const preview = await getPendingPreview(previewId);
  if (!preview) return;

  const updatedFields = { ...preview.extractedFields, summary, description };
  await updatePendingPreviewFields(previewId, updatedFields);

  // Refresh the original ephemeral message with updated summary/description
  if (responseUrl) {
    const team_id = body.team?.id;
    const user_id = body.user?.id;
    const connection = await getJiraConnection(team_id, user_id);
    if (connection) {
      const [projects, assignees, issueTypes] = await Promise.all([
        getJiraProjects(connection).catch(() => []),
        getJiraAssignableUsers(connection, selectedProjectKey).catch(() => []),
        getJiraProjectIssueTypes(connection, selectedProjectKey).catch(() => []),
      ]);
      // Restore previously selected dropdown values
      const restoredFields = {
        ...updatedFields,
        ...(selectedPriority && { priority: selectedPriority }),
        ...(selectedIssueType && { issueType: selectedIssueType }),
        ...(selectedDuedate && { duedate: selectedDuedate }),
      };
      await axios.post(responseUrl, {
        replace_original: true,
        blocks: buildPreviewBlocks(restoredFields, previewId, projects, assignees, issueTypes, selectedProjectKey, selectedAssignee, selectedDuedate, preview.originalText),
      });
    }
  }
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

const PRIORITY_OPTIONS = ["Highest", "High", "Medium", "Low", "Lowest"];
const FALLBACK_ISSUETYPE_OPTIONS = ["Task", "Bug", "Story"];
const CONNECT_TOKEN_TTL_MS = 10 * 60 * 1000;
const SLACK_SECTION_TEXT_LIMIT = 3000;
const SLACK_CONTEXT_TEXT_LIMIT = 3000;
const SLACK_FIELD_TEXT_LIMIT = 2000;
const SLACK_SELECT_OPTION_LIMIT = 100;
const THREAD_CONTEXT_MESSAGE_LIMIT = 10;
const THREAD_CONTEXT_CHAR_LIMIT = 5000;
const CHANNEL_CONTEXT_MESSAGE_LIMIT = 10;
const CHANNEL_CONTEXT_CHAR_LIMIT = 5000;

async function createTicketPreview({
  slackTeamId,
  slackUserId,
  slackChannelId,
  inputText,
  displayText = inputText,
  respond,
}) {
  const connection = await getJiraConnection(slackTeamId, slackUserId);
  if (!connection) {
    await respond(buildConnectMessage(slackTeamId, slackUserId));
    return;
  }

  let fields, projects;
  try {
    [fields, projects] = await Promise.all([
      extractJiraFields(inputText),
      getJiraProjects(connection),
    ]);
  } catch (err) {
    console.error("[Ticket preview error]", err.message);
    await respond({
      response_type: "ephemeral",
      text: `:warning: Could not prepare ticket preview: ${err.message}`,
    });
    return;
  }

  const selectedProjectKey = chooseInitialProjectKey(fields, projects);
  const [assignees, issueTypes] = await Promise.all([
    getJiraAssignableUsers(connection, selectedProjectKey).catch(() => []),
    getJiraProjectIssueTypes(connection, selectedProjectKey).catch(() => []),
  ]);

  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  const preview = await savePendingPreview({
    slackTeamId,
    slackUserId,
    slackChannelId,
    originalText: displayText,
    extractedFields: fields,
    expiresAt,
  });

  await respond({
    response_type: "ephemeral",
    text: "Jira ticket preview",
    blocks: buildPreviewBlocks(
      fields,
      preview.id,
      projects,
      assignees,
      issueTypes,
      selectedProjectKey,
      null,
      null,
      displayText
    ),
  });
}

function buildConnectMessage(slackTeamId, slackUserId) {
  const token = buildConnectToken({ slackTeamId, slackUserId });
  const connectUrl = `${process.env.APP_BASE_URL}/auth/jira/start?token=${encodeURIComponent(token)}`;

  return {
    response_type: "ephemeral",
    text: "Connect your Jira account to create tickets from Slack.",
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
  };
}

function stripSlackMentions(text) {
  return String(text || "")
    .replace(/<@[A-Z0-9]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function getMentionThreadContext({ client, event }) {
  const threadTs = event.thread_ts;
  if (!threadTs) {
    return getMentionChannelContext({ client, event });
  }

  try {
    const response = await client.conversations.replies({
      channel: event.channel,
      ts: threadTs,
      limit: THREAD_CONTEXT_MESSAGE_LIMIT,
    });

    return (response.messages || [])
      .filter((message) => message.text && message.ts !== event.ts)
      .map((message) => `- ${stripSlackMentions(message.text)}`)
      .join("\n")
      .slice(0, THREAD_CONTEXT_CHAR_LIMIT)
      .trim();
  } catch (err) {
    console.error("[Slack thread context error]", err.data?.error || err.message);
    return "";
  }
}

async function getMentionChannelContext({ client, event }) {
  try {
    const response = await client.conversations.history({
      channel: event.channel,
      latest: event.ts,
      inclusive: false,
      limit: CHANNEL_CONTEXT_MESSAGE_LIMIT,
    });

    return (response.messages || [])
      .filter((message) => message.text && !message.bot_id)
      .reverse()
      .map((message) => `- ${stripSlackMentions(message.text)}`)
      .join("\n")
      .slice(0, CHANNEL_CONTEXT_CHAR_LIMIT)
      .trim();
  } catch (err) {
    console.error("[Slack channel context error]", err.data?.error || err.message);
    return "";
  }
}

async function safePostMessage(client, message) {
  try {
    return await client.chat.postMessage(message);
  } catch (err) {
    console.error("[Slack postMessage error]", err.data?.error || err.message);
    return null;
  }
}

async function safePostEphemeral(client, message) {
  try {
    return await client.chat.postEphemeral(message);
  } catch (err) {
    const reason = err.data?.error || err.message;
    console.error("[Slack postEphemeral error]", reason);

    try {
      return await client.chat.postMessage({
        channel: message.channel,
        thread_ts: message.thread_ts,
        text: `I could not send the private Jira preview. Slack error: ${reason}`,
      });
    } catch (fallbackErr) {
      console.error("[Slack postEphemeral fallback error]", fallbackErr.data?.error || fallbackErr.message);
      return null;
    }
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncateText(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  const suffix = "... [truncated]";
  return `${text.slice(0, Math.max(0, maxLength - suffix.length))}${suffix}`;
}

function getConnectSecret() {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) {
    throw new Error("SLACK_SIGNING_SECRET is required to build Jira connect links");
  }
  return secret;
}

function signConnectPayload(payload) {
  return crypto.createHmac("sha256", getConnectSecret()).update(payload).digest("base64url");
}

function buildConnectToken({ slackTeamId, slackUserId }) {
  const payload = Buffer.from(
    JSON.stringify({
      slackTeamId,
      slackUserId,
      exp: Date.now() + CONNECT_TOKEN_TTL_MS,
    })
  ).toString("base64url");
  return `${payload}.${signConnectPayload(payload)}`;
}

function verifyConnectToken(token) {
  const [payload, signature] = String(token).split(".");
  if (!payload || !signature) {
    throw new Error("Invalid Jira connect token");
  }

  const expected = signConnectPayload(payload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    throw new Error("Invalid Jira connect token signature");
  }

  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!parsed.slackTeamId || !parsed.slackUserId || !parsed.exp || Date.now() > parsed.exp) {
    throw new Error("Expired Jira connect token");
  }

  return parsed;
}

function chooseInitialProjectKey(fields, projects) {
  if (!projects.length) return null;

  const validKeys = new Set(projects.map((p) => p.key.toUpperCase()));
  const candidates = [
    fields.projectKey,
    process.env.DEFAULT_JIRA_PROJECT_KEY,
  ]
    .filter(Boolean)
    .map((key) => String(key).trim().toUpperCase());

  return candidates.find((key) => validKeys.has(key)) || projects[0].key;
}

function makeOption(text, value) {
  return { text: { type: "plain_text", text: truncateText(text, 75), emoji: true }, value };
}

function findInitialOption(options, currentValue) {
  if (!currentValue) return options[0];
  return options.find((o) => o.value.toLowerCase() === currentValue.toLowerCase()) || options[0];
}

function buildPreviewBlocks(fields, previewId, projects = [], assignees = [], issueTypes = [], selectedProjectKey = null, selectedAssigneeId = null, selectedDuedate = null, originalText = "") {
  const projectOptions = projects.map((p) =>
    makeOption(`${p.name} (${p.key})`, p.key)
  ).slice(0, SLACK_SELECT_OPTION_LIMIT);

  const priorityOptions = PRIORITY_OPTIONS.map((p) => makeOption(p, p));
  const issueTypeNames = issueTypes.length > 0 ? issueTypes.map((t) => t.name) : FALLBACK_ISSUETYPE_OPTIONS;
  const issueTypeOptions = issueTypeNames.map((t) => makeOption(t, t)).slice(0, SLACK_SELECT_OPTION_LIMIT);

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "Jira Ticket Preview", emoji: true },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: truncateText(`:speech_balloon: *Your request:* ${originalText}`, SLACK_CONTEXT_TEXT_LIMIT),
        },
      ],
    },
    {
      type: "divider",
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: truncateText(`*Summary:*\n${fields.summary}`, SLACK_FIELD_TEXT_LIMIT) },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: truncateText(`*Description:*\n${fields.description}`, SLACK_SECTION_TEXT_LIMIT) },
    },
  ];

  // Priority select
  blocks.push({
    type: "section",
    block_id: "priority_block",
    text: { type: "mrkdwn", text: "*Priority:*" },
    accessory: {
      type: "static_select",
      action_id: "select_priority",
      options: priorityOptions,
      initial_option: findInitialOption(priorityOptions, fields.priority),
    },
  });

  // Issue type select
  blocks.push({
    type: "section",
    block_id: "issuetype_block",
    text: { type: "mrkdwn", text: "*Issue Type:*" },
    accessory: {
      type: "static_select",
      action_id: "select_issuetype",
      options: issueTypeOptions,
      initial_option: findInitialOption(issueTypeOptions, fields.issueType),
    },
  });

  // Assignee select
  if (assignees.length > 0) {
    const unassignedOption = makeOption("Unassigned", "unassigned");
    const assigneeOptions = [
      unassignedOption,
      ...assignees.map((a) => makeOption(a.displayName, a.accountId)),
    ].slice(0, SLACK_SELECT_OPTION_LIMIT);
    const defaultAssignee = selectedAssigneeId
      ? assigneeOptions.find((o) => o.value === selectedAssigneeId) || assigneeOptions[1] || unassignedOption
      : unassignedOption;
    blocks.push({
      type: "section",
      block_id: "assignee_block",
      text: { type: "mrkdwn", text: "*Assignee:*" },
      accessory: {
        type: "static_select",
        action_id: "select_assignee",
        options: assigneeOptions,
        initial_option: defaultAssignee,
      },
    });
  }

  // Due date picker
  blocks.push({
    type: "section",
    block_id: "duedate_block",
    text: { type: "mrkdwn", text: "*Due Date:*" },
    accessory: {
      type: "datepicker",
      action_id: "select_duedate",
      placeholder: { type: "plain_text", text: "Select a date", emoji: true },
      ...(selectedDuedate ? { initial_date: selectedDuedate } : {}),
    },
  });

  // Project select
  if (projectOptions.length > 0) {
    const projectAccessory = {
      type: "static_select",
      action_id: "select_project",
      placeholder: { type: "plain_text", text: "Choose a project", emoji: true },
      options: projectOptions,
    };

    if (selectedProjectKey) {
      const selectedOpt = projectOptions.find((o) => o.value === selectedProjectKey);
      if (selectedOpt) {
        projectAccessory.initial_option = selectedOpt;
      }
    }

    blocks.push({
      type: "section",
      block_id: "project_block",
      text: { type: "mrkdwn", text: "*Select Project:*" },
      accessory: projectAccessory,
    });
  }

  blocks.push({
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
      {
        type: "button",
        text: { type: "plain_text", text: "Edit Summary/Description", emoji: true },
        action_id: "edit_ticket_details",
        value: previewId,
      },
    ],
  });

  return blocks;
}

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await app.start(PORT);
    console.log(`⚡ slack-jira-ticket-bot running on port ${PORT}`);
  } catch (err) {
    if (err.data?.error === "invalid_auth" || err.data?.error === "account_inactive") {
      console.error(
        [
          "Slack authentication failed.",
          `Reason: ${err.data.error}`,
          "Check SLACK_BOT_TOKEN in .env. It must be the Bot User OAuth Token for the installed Slack app and should start with xoxb-.",
          "After changing Slack scopes or reinstalling the app, copy the new token and restart the server.",
        ].join("\n")
      );
      process.exit(1);
    }

    console.error("[Startup error]", err);
    process.exit(1);
  }
})();
