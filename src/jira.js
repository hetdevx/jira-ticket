"use strict";

const axios = require("axios");
const { getJiraConnection } = require("./db");
const { decrypt } = require("./crypto");
const { refreshJiraToken } = require("./jiraOAuth");

// Treat token as expired if it expires within the next 2 minutes
const EXPIRY_BUFFER_MS = 2 * 60 * 1000;
const refreshLocks = new Map();

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

function getConnectionKey(connection) {
  return connection.id || `${connection.slackTeamId}:${connection.slackUserId}`;
}

async function refreshConnection(connection) {
  const key = getConnectionKey(connection);
  if (refreshLocks.has(key)) {
    return refreshLocks.get(key);
  }

  const refreshPromise = refreshJiraToken(connection).finally(() => {
    refreshLocks.delete(key);
  });
  refreshLocks.set(key, refreshPromise);
  return refreshPromise;
}

async function ensureFreshConnection(connection) {
  if (!isTokenExpired(connection.tokenExpiresAt)) {
    return connection;
  }
  return refreshConnection(connection);
}

async function jiraRequest(connection, config) {
  let activeConnection = await ensureFreshConnection(connection);
  let accessToken = decrypt(activeConnection.encryptedAccessToken);

  try {
    const response = await axios.request({
      ...config,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...(config.headers || {}),
      },
    });
    return { response, connection: activeConnection };
  } catch (err) {
    if (err.response?.status !== 401) {
      throw err;
    }

    activeConnection = await refreshConnection(activeConnection);
    accessToken = decrypt(activeConnection.encryptedAccessToken);
    const response = await axios.request({
      ...config,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...(config.headers || {}),
      },
    });
    return { response, connection: activeConnection };
  }
}

async function createJiraIssueForUser({ slackTeamId, slackUserId, fields }) {
  let connection = await getJiraConnection(slackTeamId, slackUserId);

  if (!connection) {
    const err = new Error("Jira account not connected");
    err.code = "JIRA_NOT_CONNECTED";
    throw err;
  }

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
    const result = await jiraRequest(connection, {
      method: "POST",
      url,
      data: payload,
      headers: {
        "Content-Type": "application/json",
      },
    });
    response = result.response;
    connection = result.connection;
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
  const url = `https://api.atlassian.com/ex/jira/${connection.cloudId}/rest/api/3/project/search?maxResults=50&orderBy=NAME`;

  let response;
  try {
    const result = await jiraRequest(connection, { method: "GET", url });
    response = result.response;
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

  const url = `https://api.atlassian.com/ex/jira/${connection.cloudId}/rest/api/3/user/assignable/search?project=${encodeURIComponent(projectKey)}&maxResults=50`;

  let response;
  try {
    const result = await jiraRequest(connection, { method: "GET", url });
    response = result.response;
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
  const url = `https://api.atlassian.com/ex/jira/${connection.cloudId}/rest/api/3/project/${encodeURIComponent(projectKey)}`;
  try {
    const { response } = await jiraRequest(connection, { method: "GET", url });
    return (response.data.issueTypes || [])
      .filter((t) => !t.subtask)
      .map((t) => ({ id: t.id, name: t.name }));
  } catch (err) {
    console.error("[Jira getIssueTypes error]", err.response?.data || err.message);
    return [];
  }
}

module.exports = { createJiraIssueForUser, getJiraProjects, getJiraAssignableUsers, getJiraProjectIssueTypes };
