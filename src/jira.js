"use strict";

const axios = require("axios");
const { getJiraConnection } = require("./db");
const { decrypt } = require("./crypto");
const { refreshJiraToken } = require("./jiraOAuth");

// Treat token as expired if it expires within the next 2 minutes
const EXPIRY_BUFFER_MS = 2 * 60 * 1000;

function isTokenExpired(tokenExpiresAt) {
  return new Date(tokenExpiresAt).getTime() < Date.now() + EXPIRY_BUFFER_MS;
}

function buildAdf(text) {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

async function createJiraIssueForUser({ slackTeamId, slackUserId, fields }) {
  let connection = await getJiraConnection(slackTeamId, slackUserId);

  if (!connection) {
    const err = new Error("Jira account not connected");
    err.code = "JIRA_NOT_CONNECTED";
    throw err;
  }

  if (isTokenExpired(connection.tokenExpiresAt)) {
    connection = await refreshJiraToken(connection);
  }

  const accessToken = decrypt(connection.encryptedAccessToken);

  const url = `https://api.atlassian.com/ex/jira/${connection.cloudId}/rest/api/3/issue`;

  const payload = {
    fields: {
      project: { key: fields.projectKey },
      summary: fields.summary,
      description: buildAdf(fields.description),
      issuetype: { name: fields.issueType },
      priority: { name: fields.priority },
      ...(fields.assigneeAccountId ? { assignee: { accountId: fields.assigneeAccountId } } : {}),
      ...(fields.duedate ? { duedate: fields.duedate } : {}),
    },
  };

  let response;
  try {
    response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });
  } catch (err) {
    const errors = err.response?.data?.errors || {};
    const messages = err.response?.data?.errorMessages || [];
    console.error("[Jira API error detail]", JSON.stringify(err.response?.data, null, 2));

    if (errors.project) {
      throw new Error("Project not found or you don't have permission to create issues in it.");
    }
    if (errors.issuetype) {
      throw new Error("Invalid issue type for this project. Try Task, Bug, or Story.");
    }
    if (errors.priority) {
      throw new Error("Invalid priority. Try Highest, High, Medium, Low, or Lowest.");
    }
    if (messages.length > 0) {
      throw new Error(messages[0]);
    }

    throw new Error("Failed to create Jira ticket. Please try again.");
  }

  const { id, key } = response.data;

  return {
    id,
    key,
    url: `${connection.cloudUrl}/browse/${key}`,
  };
}

async function getJiraProjects(connection) {
  if (isTokenExpired(connection.tokenExpiresAt)) {
    connection = await refreshJiraToken(connection);
  }

  const accessToken = decrypt(connection.encryptedAccessToken);
  const url = `https://api.atlassian.com/ex/jira/${connection.cloudId}/rest/api/3/project/search?maxResults=50&orderBy=NAME`;

  let response;
  try {
    response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error("[Jira getProjects error]", JSON.stringify(detail));
    throw new Error("Failed to fetch Jira projects");
  }

  return (response.data.values || []).map((p) => ({
    key: p.key,
    name: p.name,
  }));
}

async function getJiraAssignableUsers(connection, projectKey) {
  if (!projectKey) {
    return [];
  }

  const accessToken = decrypt(connection.encryptedAccessToken);
  const url = `https://api.atlassian.com/ex/jira/${connection.cloudId}/rest/api/3/user/assignable/search?project=${encodeURIComponent(projectKey)}&maxResults=50`;

  let response;
  try {
    response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error("[Jira getAssignableUsers error]", JSON.stringify(detail));
    return [];
  }

  return (response.data || []).map((u) => ({
    accountId: u.accountId,
    displayName: u.displayName,
  }));
}

async function getJiraProjectIssueTypes(connection, projectKey) {
  if (!projectKey) return [];
  const accessToken = decrypt(connection.encryptedAccessToken);
  const url = `https://api.atlassian.com/ex/jira/${connection.cloudId}/rest/api/3/project/${encodeURIComponent(projectKey)}`;
  try {
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    return (response.data.issueTypes || [])
      .filter((t) => !t.subtask)
      .map((t) => ({ id: t.id, name: t.name }));
  } catch (err) {
    console.error("[Jira getIssueTypes error]", err.response?.data || err.message);
    return [];
  }
}

module.exports = { createJiraIssueForUser, getJiraProjects, getJiraAssignableUsers, getJiraProjectIssueTypes };
