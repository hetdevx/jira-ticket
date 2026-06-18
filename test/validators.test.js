"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  normalizeIssueType,
  normalizePriority,
  normalizeProjectKey,
  validateJiraFields,
} = require("../src/validators");

test("normalizes priority and issue type with safe defaults", () => {
  assert.equal(normalizePriority("high"), "High");
  assert.equal(normalizePriority("unexpected"), "Medium");
  assert.equal(normalizeIssueType("bug"), "Bug");
  assert.equal(normalizeIssueType("epic"), "Task");
});

test("normalizes explicit and fallback project keys", () => {
  process.env.DEFAULT_JIRA_PROJECT_KEY = "web";

  assert.equal(normalizeProjectKey("qa2"), "QA2");
  assert.equal(normalizeProjectKey(null), "WEB");
  assert.equal(normalizeProjectKey("not a key"), "WEB");
});

test("validates AI fields and keeps Jira-safe values", () => {
  process.env.DEFAULT_JIRA_PROJECT_KEY = "WEB";

  const fields = validateJiraFields({
    summary: "x".repeat(300),
    description: "  ",
    priority: "lowest",
    issueType: "story",
    projectKey: "app",
  });

  assert.equal(fields.summary.length, 255);
  assert.equal(fields.description, fields.summary);
  assert.equal(fields.priority, "Lowest");
  assert.equal(fields.issueType, "Story");
  assert.equal(fields.projectKey, "APP");
});
