# slack-jira-ticket-bot

A Slack bot that lets each Slack user connect their own Jira account via Atlassian OAuth 2.0 (3LO) and create Jira tickets directly from natural language Slack messages.

---

## What it does

1. User runs `/jira-ticket Create high priority task to improve storefront SEO page titles. Project WEB.`
2. Bot checks if this Slack user has connected their Jira account.
3. If not connected — bot sends an ephemeral **Connect Jira** button.
4. User clicks the button, completes Atlassian OAuth consent in their browser.
5. Bot stores the user's Jira OAuth tokens (encrypted) in Neon DB.
6. On the next `/jira-ticket` run — bot uses AI to extract ticket fields and shows a preview.
7. User clicks **Create Jira Ticket** — bot creates the issue in Jira and replies with the link.

---

## Architecture

```
Slack Workspace
  └── /jira-ticket command ──► Express + Slack Bolt (src/app.js)
                                  ├── AI extraction (src/ai.js)   ← any OpenAI-compatible API
                                  ├── Jira OAuth (src/jiraOAuth.js)
                                  ├── Jira API (src/jira.js)
                                  ├── DB layer (src/db.js)        ← Prisma + Neon DB
                                  └── Token crypto (src/crypto.js) ← AES-256-GCM
```

**Key design decisions:**
- Per-user OAuth: every Slack user connects their own Jira account independently.
- Encrypted tokens: access and refresh tokens are AES-256-GCM encrypted before being stored.
- Rotating refresh tokens: Atlassian issues new refresh tokens on every refresh — the bot always stores the latest.
- Plug-and-play AI: any OpenAI-compatible endpoint works (Ollama, Groq, OpenRouter, OpenAI).

---

## Prerequisites

- Node.js >= 18
- A [Neon DB](https://neon.tech) PostgreSQL database
- A Slack app (see setup below)
- An Atlassian OAuth 2.0 app (see setup below)
- An AI provider (Ollama for free local, or any OpenAI-compatible API)

---

## PostgreSQL setup (Neon DB)

1. Go to [neon.tech](https://neon.tech) and create a free account.
2. Create a new project and database.
3. From the Neon dashboard, copy:
   - **Connection string (pooled)** → `DATABASE_URL`
   - **Connection string (direct / non-pooled)** → `DIRECT_URL`

Neon requires both: Prisma uses the direct URL for migrations and the pooled URL for queries.

---

## Running the database migration

```bash
npm run migrate:dev
```

This runs `prisma migrate dev` which creates the tables in your Neon database.

For production deployments:

```bash
npm run migrate
```

---

## Slack app setup

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App → From scratch**.
2. Name it `Jira Ticket Bot` and pick your workspace.
3. In **OAuth & Permissions → Scopes → Bot Token Scopes**, add:
   - `commands`
   - `chat:write`
   - `app_mentions:read`
   - `channels:history` (optional, used to include public-channel thread or recent-channel context)
   - `groups:history` (optional, used to include private-channel thread or recent-channel context)
4. Click **Install to Workspace** and copy the **Bot User OAuth Token** → `SLACK_BOT_TOKEN`.
5. From **Basic Information**, copy the **Signing Secret** → `SLACK_SIGNING_SECRET`.
6. In **Slash Commands**, click **Create New Command**:
   - Command: `/jira-ticket`
   - Request URL: `${APP_BASE_URL}/slack/events`
   - Short Description: `Create a Jira ticket from natural language`
7. Create another slash command:
   - Command: `/jira-disconnect`
   - Request URL: `${APP_BASE_URL}/slack/events`
   - Short Description: `Disconnect your Jira account`
8. In **Interactivity & Shortcuts**:
   - Toggle **Interactivity** on.
   - Request URL: `${APP_BASE_URL}/slack/events`
9. In **Event Subscriptions**:
   - Toggle **Enable Events** on.
   - Request URL: `${APP_BASE_URL}/slack/events`
   - Under **Subscribe to bot events**, add `app_mention`
10. Reinstall the app after saving changes.

---

## Atlassian OAuth app setup

1. Go to [developer.atlassian.com/console/myapps](https://developer.atlassian.com/console/myapps/).
2. Click **Create** → **OAuth 2.0 integration**.
3. Name it (e.g. `Slack Jira Bot`) and agree to terms.
4. In **Authorization**, add a callback URL:
   ```
   ${APP_BASE_URL}/auth/jira/callback
   ```
5. In **Permissions**, add the **Jira API** and enable these scopes:
   - `read:jira-user`
   - `read:jira-work`
   - `write:jira-work`
6. From **Settings**, copy:
   - **Client ID** → `ATLASSIAN_CLIENT_ID`
   - **Secret** → `ATLASSIAN_CLIENT_SECRET`

The app also sends `offline_access` in the OAuth authorization URL so Atlassian returns refresh tokens. This usually does not appear as a Jira permission checkbox in the Atlassian Developer Console.

For internal testing, make sure the Atlassian OAuth app is available to the users who will connect Jira. If users cannot complete consent, check the app distribution/settings in Atlassian Developer Console.

---

## Environment variables

Copy `.env.example` to `.env` and fill in every value:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `PORT` | Server port (default `3000`) |
| `APP_BASE_URL` | Your public URL, e.g. `https://abc123.ngrok.io` |
| `DATABASE_URL` | Neon DB pooled connection string |
| `DIRECT_URL` | Neon DB direct (non-pooled) connection string |
| `SLACK_BOT_TOKEN` | Bot User OAuth Token from Slack |
| `SLACK_SIGNING_SECRET` | Signing Secret from Slack Basic Information |
| `ATLASSIAN_CLIENT_ID` | OAuth app client ID from Atlassian Developer Console |
| `ATLASSIAN_CLIENT_SECRET` | OAuth app secret from Atlassian Developer Console |
| `ATLASSIAN_REDIRECT_URI` | Must match exactly: `${APP_BASE_URL}/auth/jira/callback` |
| `AI_BASE_URL` | Base URL of your AI provider (default: Ollama local) |
| `AI_API_KEY` | API key for your AI provider (`ollama` for local) |
| `AI_MODEL` | Model name (e.g. `llama3.1`, `llama3`, `gpt-4o`) |
| `DEFAULT_JIRA_PROJECT_KEY` | Fallback Jira project key if not mentioned in command |
| `TOKEN_ENCRYPTION_KEY` | 32-byte key as 64 hex chars — see below |

**Generating TOKEN_ENCRYPTION_KEY:**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Ollama setup (free local AI)

```bash
# Install Ollama: https://ollama.com
ollama pull llama3.1
ollama serve
```

Set in `.env`:
```env
AI_BASE_URL=http://localhost:11434/v1
AI_API_KEY=ollama
AI_MODEL=llama3.1
```

**Alternative providers (no local GPU needed):**

| Provider | AI_BASE_URL | Notes |
|---|---|---|
| Groq | `https://api.groq.com/openai/v1` | Free tier available |
| OpenRouter | `https://openrouter.ai/api/v1` | Many models |
| OpenAI | `https://api.openai.com/v1` | GPT-4o etc. |

---

## Running locally

```bash
npm install
cp .env.example .env
# fill in .env
npm run migrate:dev   # create DB tables
npm run dev           # start the bot
```

The Prisma schema lives in `prisma/schema.prisma`, and the application DB wrapper is `src/db.js`.

---

## Jira permissions and site selection

This bot creates Jira issues using the connected Atlassian user's OAuth token.

The connected Jira user must have permission to create issues in the selected Jira project. If the user cannot create the issue manually in Jira, the bot also cannot create it for them.

If a user has access to multiple Jira Cloud sites, this MVP uses the first accessible Jira site returned by Atlassian. In production, add a Jira site picker so users can choose the intended site during connection.

---

## ngrok setup (expose local server to Slack)

Slack needs a public HTTPS URL to send events to your local machine.

```bash
# Install ngrok: https://ngrok.com
ngrok http 3000
```

Copy the `https://...ngrok.io` URL and:
1. Set `APP_BASE_URL=https://abc123.ngrok.io` in `.env`
2. Set `ATLASSIAN_REDIRECT_URI=https://abc123.ngrok.io/auth/jira/callback` in `.env`
3. Update your Slack app's Slash Command URL and Interactivity URL.
4. Update your Atlassian app's callback URL.
5. Restart the bot (`npm run dev`).

> **Note:** Free ngrok URLs change on every restart. For persistent testing, use a paid ngrok plan or a service like [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).

---

## Testing the full flow

**Step 1 — Run the command:**

```
/jira-ticket Create a high priority task to improve Storefront QA Agent dashboard. It should show page title, SEO score, meta description and performance score. Project WEB.
```

You can include assignee and due date hints:

```
/jira-ticket Create high priority task to improve storefront SEO page titles. Due date 30 June. Assign to Het.
```

You can also mention the bot in a channel:

```
@Jira Ticket Bot create a high priority task to improve storefront SEO page titles. Project WEB.
```

When you mention the bot inside a thread, it will try to include recent thread messages as context if the Slack app has the relevant history scope for that channel type.

When you mention the bot in a normal channel message, it will try to include up to 10 recent messages before the mention. The bot must be invited to the channel, and the Slack app must have `channels:history` for public channels or `groups:history` for private channels.

**Step 2 — Connect Jira** (first time only):
- Bot shows a **Connect Jira** button.
- Click it, log in to Atlassian, and grant access.
- Browser shows "Jira Connected!" — return to Slack.

**Step 3 — Create the ticket:**
- Run the command again.
- Bot shows a preview with the extracted fields.
- Click **Create Jira Ticket**.
- Bot replies with the Jira issue key and link.

---

## Troubleshooting

**`Invalid OAuth state` on callback:**
OAuth states expire after 10 minutes. Click the Connect Jira button again and complete the flow without delay.

**`No Jira sites found` on callback:**
Your Atlassian account must have access to at least one Jira Cloud site. Make sure you logged in with the correct account.

**AI returns non-JSON:**
Try a larger or more capable model. Set `AI_MODEL=llama3.1` with Ollama or use Groq's `llama3-8b-8192`.

**`JIRA_NOT_CONNECTED` error:**
The Jira connection record is missing. Run `/jira-ticket` and click Connect Jira again.

**Token expired / refresh fails:**
If the refresh token is invalid, disconnect by deleting the row from `jira_connections` in Neon and reconnecting. This can happen if the Atlassian app's permissions change.

**Slack signature verification failed:**
Make sure `SLACK_SIGNING_SECRET` matches your Slack app's signing secret exactly. Also ensure your server's clock is accurate (Slack signatures are time-sensitive).

**ngrok URL changed:**
Update `APP_BASE_URL`, `ATLASSIAN_REDIRECT_URI`, Slack URLs, and Atlassian callback URL whenever ngrok gives you a new URL.
# jira-ticket
