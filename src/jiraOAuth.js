"use strict";

const crypto = require("crypto");
const axios = require("axios");
const { saveOAuthState, consumeOAuthState, upsertJiraConnection } = require("./db");
const { encrypt } = require("./crypto");

const ATLASSIAN_AUTH_URL = "https://auth.atlassian.com/authorize";
const ATLASSIAN_TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const ATLASSIAN_RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources";

const SCOPES = "read:jira-user write:jira-work offline_access";

async function buildJiraAuthUrl({ slackTeamId, slackUserId }) {
  const state = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await saveOAuthState({ state, slackTeamId, slackUserId, expiresAt });

  const params = new URLSearchParams({
    audience: "api.atlassian.com",
    client_id: process.env.ATLASSIAN_CLIENT_ID,
    scope: SCOPES,
    redirect_uri: process.env.ATLASSIAN_REDIRECT_URI,
    state,
    response_type: "code",
    prompt: "consent",
  });

  return `${ATLASSIAN_AUTH_URL}?${params.toString()}`;
}

async function handleJiraCallback({ code, state }) {
  const oauthState = await consumeOAuthState(state);
  if (!oauthState) {
    throw new Error("Invalid or expired OAuth state. Please try connecting Jira again.");
  }

  const { slackTeamId, slackUserId } = oauthState;

  const tokenResponse = await axios.post(
    ATLASSIAN_TOKEN_URL,
    {
      grant_type: "authorization_code",
      client_id: process.env.ATLASSIAN_CLIENT_ID,
      client_secret: process.env.ATLASSIAN_CLIENT_SECRET,
      code,
      redirect_uri: process.env.ATLASSIAN_REDIRECT_URI,
    },
    { headers: { "Content-Type": "application/json" } }
  );

  const { access_token, refresh_token, expires_in, scope } = tokenResponse.data;

  const resourcesResponse = await axios.get(ATLASSIAN_RESOURCES_URL, {
    headers: { Authorization: `Bearer ${access_token}` },
  });

  const resources = resourcesResponse.data;
  if (!resources || resources.length === 0) {
    throw new Error("No Jira sites found on this Atlassian account.");
  }

  // Pick the first resource for MVP
  const site = resources[0];

  const tokenExpiresAt = new Date(Date.now() + expires_in * 1000);

  await upsertJiraConnection({
    slackTeamId,
    slackUserId,
    atlassianAccountId: null,
    atlassianEmail: null,
    cloudId: site.id,
    cloudName: site.name,
    cloudUrl: site.url,
    encryptedAccessToken: encrypt(access_token),
    encryptedRefreshToken: encrypt(refresh_token),
    tokenExpiresAt,
    scopes: scope || SCOPES,
  });

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Jira Connected</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f4f5f7; }
    .card { background: #fff; border-radius: 8px; padding: 40px 48px; text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,.12); max-width: 400px; }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { margin: 0 0 8px; font-size: 22px; color: #172b4d; }
    p { color: #5e6c84; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">&#10003;</div>
    <h1>Jira Connected!</h1>
    <p>Your Jira account (<strong>${site.name}</strong>) has been connected successfully.<br/>You can close this tab and return to Slack.</p>
  </div>
</body>
</html>
`;
}

async function refreshJiraToken(connection) {
  const { decrypt, encrypt: encryptToken } = require("./crypto");
  const { upsertJiraConnection: save } = require("./db");

  const refreshToken = decrypt(connection.encryptedRefreshToken);

  const response = await axios.post(
    ATLASSIAN_TOKEN_URL,
    {
      grant_type: "refresh_token",
      client_id: process.env.ATLASSIAN_CLIENT_ID,
      client_secret: process.env.ATLASSIAN_CLIENT_SECRET,
      refresh_token: refreshToken,
    },
    { headers: { "Content-Type": "application/json" } }
  );

  const { access_token, refresh_token: new_refresh_token, expires_in } = response.data;
  const tokenExpiresAt = new Date(Date.now() + expires_in * 1000);

  const updated = await save({
    slackTeamId: connection.slackTeamId,
    slackUserId: connection.slackUserId,
    atlassianAccountId: connection.atlassianAccountId,
    atlassianEmail: connection.atlassianEmail,
    cloudId: connection.cloudId,
    cloudName: connection.cloudName,
    cloudUrl: connection.cloudUrl,
    encryptedAccessToken: encryptToken(access_token),
    // Atlassian uses rotating refresh tokens — update if a new one was issued
    encryptedRefreshToken: new_refresh_token
      ? encryptToken(new_refresh_token)
      : connection.encryptedRefreshToken,
    tokenExpiresAt,
    scopes: connection.scopes,
  });

  return updated;
}

module.exports = { buildJiraAuthUrl, handleJiraCallback, refreshJiraToken };
