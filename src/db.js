"use strict";

const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function saveOAuthState({ state, slackTeamId, slackUserId, expiresAt }) {
  await prisma.oAuthState.create({
    data: {
      state,
      slackTeamId,
      slackUserId,
      expiresAt,
    },
  });
}

async function consumeOAuthState(state) {
  const record = await prisma.oAuthState.findUnique({ where: { state } });
  if (!record) return null;
  if (new Date() > record.expiresAt) {
    await prisma.oAuthState.delete({ where: { state } });
    return null;
  }
  await prisma.oAuthState.delete({ where: { state } });
  return record;
}

async function getJiraConnection(slackTeamId, slackUserId) {
  return prisma.jiraConnection.findUnique({
    where: {
      slackTeamId_slackUserId: { slackTeamId, slackUserId },
    },
  });
}

async function upsertJiraConnection(connection) {
  const {
    slackTeamId,
    slackUserId,
    atlassianAccountId,
    atlassianEmail,
    cloudId,
    cloudName,
    cloudUrl,
    encryptedAccessToken,
    encryptedRefreshToken,
    tokenExpiresAt,
    scopes,
  } = connection;

  return prisma.jiraConnection.upsert({
    where: {
      slackTeamId_slackUserId: { slackTeamId, slackUserId },
    },
    update: {
      atlassianAccountId,
      atlassianEmail,
      cloudId,
      cloudName,
      cloudUrl,
      encryptedAccessToken,
      encryptedRefreshToken,
      tokenExpiresAt,
      scopes,
    },
    create: {
      slackTeamId,
      slackUserId,
      atlassianAccountId,
      atlassianEmail,
      cloudId,
      cloudName,
      cloudUrl,
      encryptedAccessToken,
      encryptedRefreshToken,
      tokenExpiresAt,
      scopes,
    },
  });
}

async function savePendingPreview(preview) {
  const { slackTeamId, slackUserId, slackChannelId, originalText, extractedFields, expiresAt } =
    preview;
  return prisma.pendingTicketPreview.create({
    data: {
      slackTeamId,
      slackUserId,
      slackChannelId,
      originalText,
      extractedFields,
      expiresAt,
    },
  });
}

async function getPendingPreview(id) {
  return prisma.pendingTicketPreview.findUnique({ where: { id } });
}

async function deletePendingPreview(id) {
  try {
    await prisma.pendingTicketPreview.delete({ where: { id } });
  } catch {
    // already deleted or never existed — safe to ignore
  }
}

module.exports = {
  prisma,
  saveOAuthState,
  consumeOAuthState,
  getJiraConnection,
  upsertJiraConnection,
  savePendingPreview,
  getPendingPreview,
  deletePendingPreview,
};
