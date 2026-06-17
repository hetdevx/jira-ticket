"use strict";

require("dotenv").config();

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
              text: `:white_check_mark: *You're connected to Jira!*\n\nYour account has been linked to *${cloudName}*. You can now create tickets directly from Slack.\n\nRun \`/jira-ticket <your request>\` to get started.`,
            },
          },
        ],
        text: `You're now connected to Jira (${cloudName}). Run /jira-ticket to create tickets.`,
      });
    } catch (dmErr) {
      console.error("[Slack DM error]", dmErr.message);
    }

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

  // Extract fields with AI and fetch projects in parallel
  let fields, projects;
  try {
    [fields, projects] = await Promise.all([
      extractJiraFields(text.trim()),
      getJiraProjects(connection),
    ]);
  } catch (err) {
    console.error("[AI extraction error]", err.message);
    await respond({
      response_type: "ephemeral",
      text: `:warning: Could not extract ticket fields: ${err.message}`,
    });
    return;
  }

  const firstProjectKey = projects.length > 0 ? projects[0].key : null;
  const [assignees, issueTypes] = await Promise.all([
    getJiraAssignableUsers(connection, firstProjectKey).catch(() => []),
    getJiraProjectIssueTypes(connection, firstProjectKey).catch(() => []),
  ]);

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
    blocks: buildPreviewBlocks(fields, preview.id, projects, assignees, issueTypes, firstProjectKey, null, null, text.trim()),
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

function makeOption(text, value) {
  return { text: { type: "plain_text", text, emoji: true }, value };
}

function findInitialOption(options, currentValue) {
  if (!currentValue) return options[0];
  return options.find((o) => o.value.toLowerCase() === currentValue.toLowerCase()) || options[0];
}

function buildPreviewBlocks(fields, previewId, projects = [], assignees = [], issueTypes = [], selectedProjectKey = null, selectedAssigneeId = null, selectedDuedate = null, originalText = "") {
  const projectOptions = projects.map((p) =>
    makeOption(`${p.name} (${p.key})`, p.key)
  );

  const priorityOptions = PRIORITY_OPTIONS.map((p) => makeOption(p, p));
  const issueTypeNames = issueTypes.length > 0 ? issueTypes.map((t) => t.name) : FALLBACK_ISSUETYPE_OPTIONS;
  const issueTypeOptions = issueTypeNames.map((t) => makeOption(t, t));

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
          text: `:speech_balloon: *Your request:* ${originalText}`,
        },
      ],
    },
    {
      type: "divider",
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Summary:*\n${fields.summary}` },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Description:*\n${fields.description}` },
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

  // Assignee select — preselect first real user by default
  if (assignees.length > 0) {
    const unassignedOption = makeOption("Unassigned", "unassigned");
    const assigneeOptions = [
      unassignedOption,
      ...assignees.map((a) => makeOption(a.displayName, a.accountId)),
    ];
    const defaultAssignee = selectedAssigneeId
      ? assigneeOptions.find((o) => o.value === selectedAssigneeId) || assigneeOptions[1] || unassignedOption
      : assigneeOptions[1] || unassignedOption; // preselect first real user
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
  await app.start(PORT);
  console.log(`⚡ slack-jira-ticket-bot running on port ${PORT}`);
})();
