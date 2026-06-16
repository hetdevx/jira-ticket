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
    },
  };

  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });

  const { id, key } = response.data;

  return {
    id,
    key,
    url: `${connection.cloudUrl}/browse/${key}`,
  };
}

module.exports = { createJiraIssueForUser };
