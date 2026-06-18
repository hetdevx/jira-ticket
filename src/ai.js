"use strict";

const axios = require("axios");
const { validateJiraFields } = require("./validators");

// Generic OpenAI-compatible client — works with Ollama, Groq, OpenRouter, OpenAI, etc.
// Just set AI_BASE_URL, AI_API_KEY, and AI_MODEL in .env.

const SYSTEM_PROMPT = `You are a Jira ticket assistant. Extract structured Jira issue fields from the user's natural language input.

Respond ONLY with valid JSON matching this schema:
{
  "summary": "short Jira issue title (max 255 chars)",
  "description": "clear Jira issue description",
  "priority": "Highest | High | Medium | Low | Lowest",
  "issueType": "Task | Bug | Story",
  "projectKey": "Jira project key if explicitly mentioned, otherwise null"
}

Rules:
- summary must be concise and descriptive
- description must expand on the summary with relevant details
- priority defaults to Medium if not specified
- issueType defaults to Task if not specified
- projectKey must only be set when the user explicitly mentions a project key such as WEB, APP, or QA
- Do not include any explanation, markdown, or extra text — only the JSON object`;

async function extractJiraFields(inputText) {
  const baseURL = (process.env.AI_BASE_URL || "http://localhost:11434/v1").replace(/\/$/, "");
  const apiKey = process.env.AI_API_KEY || "ollama";
  const model = process.env.AI_MODEL || "llama3.1";

  let response;
  try {
    response = await axios.post(
      `${baseURL}/chat/completions`,
      {
        model,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Extract Jira fields from this input:\n\n${inputText}`,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.response?.data || err.message;
    throw new Error(`AI request failed: ${JSON.stringify(detail)}`);
  }

  const raw = response.data?.choices?.[0]?.message?.content || "";


  // Strip markdown code fences if the model wrapped the JSON
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`AI returned non-JSON output: ${cleaned.slice(0, 200)}`);
  }

  return validateJiraFields(parsed);
}

module.exports = { extractJiraFields };
