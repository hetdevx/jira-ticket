"use strict";

const ALLOWED_PRIORITIES = ["Highest", "High", "Medium", "Low", "Lowest"];
const ALLOWED_ISSUE_TYPES = ["Task", "Bug", "Story"];
const MAX_SUMMARY_LENGTH = 255;

function normalizePriority(priority) {
  if (!priority) return "Medium";
  const match = ALLOWED_PRIORITIES.find(
    (p) => p.toLowerCase() === String(priority).toLowerCase()
  );
  return match || "Medium";
}

function normalizeIssueType(issueType) {
  if (!issueType) return "Task";
  const match = ALLOWED_ISSUE_TYPES.find(
    (t) => t.toLowerCase() === String(issueType).toLowerCase()
  );
  return match || "Task";
}

function normalizeProjectKey(projectKey) {
  const key = String(projectKey || process.env.DEFAULT_JIRA_PROJECT_KEY || "WEB")
    .trim()
    .toUpperCase();
  return /^[A-Z][A-Z0-9_]{1,9}$/.test(key) ? key : "WEB";
}

function validateJiraFields(fields) {
  if (!fields || typeof fields !== "object") {
    throw new Error("AI returned invalid fields: expected an object");
  }

  if (!fields.summary || typeof fields.summary !== "string" || !fields.summary.trim()) {
    throw new Error("AI returned invalid fields: summary is required");
  }

  if (!fields.description || typeof fields.description !== "string") {
    throw new Error("AI returned invalid fields: description is required");
  }

  const summary = fields.summary.trim().slice(0, MAX_SUMMARY_LENGTH);
  const description = fields.description.trim() || summary;

  const normalized = {
    summary,
    description,
    priority: normalizePriority(fields.priority),
    issueType: normalizeIssueType(fields.issueType),
    projectKey: normalizeProjectKey(fields.projectKey),
  };

  return normalized;
}

module.exports = { validateJiraFields, normalizePriority, normalizeIssueType, normalizeProjectKey };
