# API Endpoint Executability Validator Agent

**Role:** Agents Engineer | **Duration:** 90 minutes | **Format:** Hands-on implementation with an AI coding agent

---

## Context

At Composio, we integrate with 2,000+ apps and 42,000+ API endpoints. Before we build an integration for any endpoint, we need to verify that the endpoint can actually be executed successfully — that it exists, the auth works, and a well-formed request gets a valid response.

Your job is to **build an agent that automates this verification**. Given a set of API endpoint definitions for any app, your agent should attempt to execute each one and determine:

- Can this endpoint be successfully called at least once? If yes, it's **valid**.
- Does this endpoint actually exist? If not, it's **invalid** (fake/wrong path/wrong method).
- Does the connected account have the right permissions? If not, it's an **auth/scope issue**.
- Did something else go wrong? If so, capture the error.

**This is not about testing business logic or edge cases.** You're doing a single-request sanity check: "Can I successfully execute this endpoint with a reasonable request?" If you get one successful response, that endpoint passes. If the endpoint is genuinely broken or doesn't exist, your agent should recognize that and report it clearly.

## What makes this hard

Some endpoints are **fake** — they don't exist in the real API. Your agent needs to tell the difference between "this endpoint doesn't exist" and "I called it wrong."

Some endpoints have **dependencies** — you can't call `GET /messages/{messageId}` without first calling `GET /messages` to get a valid ID. Your agent needs to figure this out dynamically, for any app.

Some endpoints need **request bodies** — your agent needs to construct minimal valid payloads based on the parameter definitions.

Some endpoints will fail due to **insufficient scopes** — the connected account may not have the right permissions. Your agent should detect this (typically a 403) and classify it correctly, not keep retrying.

Your agent should handle all of this for **any app** — not just the sample Gmail/Calendar endpoints. Don't hardcode app-specific logic.

## Sample data

You're given 16 sample endpoints in `src/endpoints.json`: 10 Gmail + 6 Google Calendar. The mix includes:
- Valid endpoints that should return successful responses
- Fake endpoints that don't exist in the real API
- Endpoints that may fail due to missing scopes

Use these to develop and sanity-check your solution. But keep in mind: **we will run your agent against other apps and endpoints during evaluation.**

### Endpoint definition format

Each endpoint in `endpoints.json` looks like this:

```json
{
  "tool_slug": "GMAIL_LIST_MESSAGES",
  "description": "Lists the messages in the user's mailbox.",
  "method": "GET",
  "path": "/gmail/v1/users/me/messages",
  "required_scopes": ["https://www.googleapis.com/auth/gmail.readonly"],
  "parameters": {
    "query": [
      { "name": "maxResults", "type": "integer", "required": false, "description": "Maximum number of messages to return." }
    ],
    "path": [],
    "body": null
  }
}
```

- `tool_slug` — a unique identifier for the endpoint (used in reporting, not for execution)
- `method` + `path` — the actual HTTP endpoint to call
- `required_scopes` — what permissions the endpoint needs
- `parameters` — query params, path params (like `{messageId}`), and request body schema

## How to call endpoints: `proxyExecute()`

Use `composio.tools.proxyExecute()` to call endpoints. You give it the HTTP method and path, and Composio handles all authentication (OAuth tokens, refresh, etc.) for you.

```typescript
import { Composio } from "@composio/core";

const composio = new Composio();

// Simple GET request
const result = await composio.tools.proxyExecute({
  endpoint: "/gmail/v1/users/me/messages",
  method: "GET",
  connectedAccountId: "candidate",
  parameters: [
    { in: "query", name: "maxResults", value: 5 }
  ],
});

// POST request with a body
const result = await composio.tools.proxyExecute({
  endpoint: "/calendar/v3/calendars/primary/events",
  method: "POST",
  connectedAccountId: "candidate",
  body: {
    summary: "Test Event",
    start: { dateTime: "2026-03-25T10:00:00Z", timeZone: "UTC" },
    end: { dateTime: "2026-03-25T11:00:00Z", timeZone: "UTC" },
  },
});
```

**`proxyExecute` parameters:**
| Parameter | Required | Description |
|-----------|----------|-------------|
| `endpoint` | Yes | API path (e.g., `/gmail/v1/users/me/messages`) |
| `method` | Yes | `"GET"`, `"POST"`, `"PUT"`, `"DELETE"`, or `"PATCH"` |
| `connectedAccountId` | Yes | Use `"candidate"` (set up during `setup.sh`) |
| `parameters` | No | Array of `{ in: "query" \| "header", name, value }` |
| `body` | No | Request body object for POST/PUT/PATCH |

**Response structure:**

```typescript
interface ProxyExecuteResponse {
  status: number;                        // HTTP status code (200, 404, 403, etc.)
  data?: unknown;                        // Response body (JSON)
  headers?: Record<string, string>;      // Response headers
}
```

Use `result.status` to classify endpoints: 2xx = valid, 404 = invalid, 403 = insufficient scopes, etc.

**Important:**
- **Do NOT make raw HTTP requests** or extract bearer tokens manually. `proxyExecute()` handles all auth.
- **Path parameters** (like `{messageId}`) must be substituted into the path string before calling. `proxyExecute` only handles query and header params.
- **OAuth, token refresh, and rate limits** are handled by Composio — these are out of scope for your agent.
- **Your agent will take real actions** on the connected Google account (send emails, trash messages, create/delete calendar events). Use a secondary or throwaway Google account if possible.

## Classification

Your agent must classify each endpoint into one of these statuses:

| Status | Meaning | Typical signals |
|--------|---------|-----------------|
| `valid` | Endpoint exists and can be successfully executed | Any 2xx response (200, 201, 204, etc.) |
| `invalid_endpoint` | Endpoint does not exist | 404, "not found", method not allowed |
| `insufficient_scopes` | Endpoint exists but account lacks permissions | 403, "forbidden", "insufficient permissions" |
| `error` | Something else went wrong | 400, 500, timeouts, malformed responses |

**What counts as "valid":** Any 2xx response means the endpoint works. Your agent doesn't need to validate the response body or test multiple scenarios — one successful call is enough.

**Key challenge — avoiding false negatives:** The most common mistake is classifying a valid endpoint as `error` because your agent constructed a bad request (wrong params, missing required fields, bad path parameter). Think carefully about how your agent avoids this. A valid endpoint that your agent fails to call correctly is worse than admitting uncertainty.

## Dependency resolution

Some endpoints need data from other endpoints. For example:

```
GET /gmail/v1/users/me/messages/{messageId}
```

Your agent can't just make up a `messageId`. It needs to:
1. Recognize that `{messageId}` is a path parameter
2. Find another endpoint that can provide a valid message ID (e.g., `GET /messages` → pick an ID from the response)
3. Substitute the real ID into the path
4. Then call the endpoint

This "list → pick item → use in detail request" pattern appears across most APIs. Your agent should handle it generically — not just for Gmail messages, but for any resource type in any app.

## Architecture

**One agent per endpoint** — each endpoint should be tested by its own agent instance. Don't use a single agent that sequentially loops through all endpoints.

**No hardcoded execution order** — agents should run in any order (or concurrently). If an agent needs data from another endpoint, it resolves that dependency dynamically.

**Think about how your agent avoids its own mistakes.** The biggest risk isn't fake endpoints — it's your agent misusing valid endpoints (wrong params, bad payload) and then misclassifying them as invalid. Good architectures have strategies for this:
- How does the agent construct valid requests from the parameter definitions?
- How does it distinguish "this endpoint doesn't exist" from "I called it wrong"?
- Does it retry with different parameters before giving up?

We care more about the quality of your architecture than whether you got 100% accuracy on the sample data. **A well-architected agent with a minor bug scores better than a hacky script that gets the right answers on 16 endpoints but would break on the 17th.**

## What you must submit

1. **Your agent implementation** — implement `runAgent()` in `src/agent.ts`
2. **A test report** — `report.json` generated by `bun src/run.ts`
3. **An architecture doc** — fill out `ARCHITECTURE.md` in the project root. Explain:
   - Your agent's design and how it works
   - How you handle dependency resolution
   - How you avoid false negatives (misclassifying valid endpoints)
   - What tradeoffs you made and what you'd improve with more time
   - Why you chose your particular architecture pattern (single agent, multi-agent, orchestrator, etc.)
4. **A Loom video** (2–4 minutes) covering:
   - Walk through your architecture and key design decisions
   - Explain your dependency resolution strategy
   - Discuss failure modes — what could go wrong and how your agent handles it
   - What you'd improve or do differently with more time

The architecture doc and video are **part of your evaluation**. Even if your agent scores perfectly on the sample data, a poor explanation of your architecture will lower your score. Conversely, a thoughtful architecture with a clear explanation can score well even if your agent has a bug that reduces accuracy.

## Evaluation

### How we evaluate

Your agent will be run against the sample Gmail/Calendar endpoints as a sanity check, and then against additional apps and endpoints you haven't seen.

### What we look for

- **Correctness across apps** — How accurately does your agent classify endpoints? Are fake endpoints caught? Are scope issues detected? Does it handle different API styles, error formats, and response structures? This is the most important factor.
- **Avoiding false negatives** — Does your agent minimize cases where it fails to execute a valid endpoint due to its own mistakes (bad params, missing body, wrong path substitution)?
- **Dependency resolution** — Can your agent handle endpoints that need data from other endpoints? Does it figure this out dynamically?
- **Architecture quality** — Is this a real agent with good reasoning, or just a loop? Is the design explained clearly in the architecture doc and video? Would this approach scale to thousands of endpoints across hundreds of apps?
- **Completeness** — Does every endpoint get tested and reported?
- **Code quality** — Clean abstractions, good error handling, readable code

### Architecture matters more than score

We evaluate your **thinking and design** as much as your results. A thoughtful, well-explained architecture that would generalize well — but happens to have a bug on the sample data — is more valuable to us than a hardcoded solution that gets 100% on Gmail but would fall apart on Stripe or Jira.

## Constraints

### Use an AI coding agent

Use an AI coding agent to build your solution. Our recommended workflow:

- **[Codex CLI](https://github.com/openai/codex) with GPT-5.3-Codex** for implementation — fast and accurate for coding tasks
- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code) with Claude Opus 4.6** for high-level planning, architecture design, and writing your `ARCHITECTURE.md`

You're welcome to use whatever AI tools you prefer — [Cursor](https://cursor.com), Windsurf, or any other agent. Use your own API keys / subscriptions. We care about the result, not the specific tool.

**Can't afford API access?** Reach out to **prateek@composio.dev** or **pranjali@composio.dev** — we'll provide API keys so cost isn't a barrier.

### Tech stack

Use **Bun** (not Node.js). The project is already set up for Bun. You are free to use any additional libraries.

## Getting Started

1. **Get your Composio API key** from [platform.composio.dev](https://platform.composio.dev) (free account).

2. **Run the setup script:**
   ```bash
   COMPOSIO_API_KEY=<your_key> sh setup.sh
   ```
   This installs dependencies, creates auth configs, connects your Google account via OAuth, and runs a sanity check to verify `proxyExecute()` works. The connected account ID is `"candidate"`.

3. **Explore the sample endpoints:**
   ```bash
   bun src/index.ts
   ```

4. **Implement your agent** in `src/agent.ts` (see type definitions in `src/types.ts`).

5. **Run and validate:**
   ```bash
   bun src/run.ts
   ```
   This calls your `runAgent()`, validates the output, and writes `report.json`.

6. **Write your architecture doc** in `ARCHITECTURE.md`.

## Project Structure

```
src/
├── agent.ts          <- YOUR IMPLEMENTATION GOES HERE
├── types.ts          <- Input/output type definitions (do not modify)
├── run.ts            <- Runner that calls your agent and validates output (do not modify)
├── endpoints.json    <- Sample endpoint definitions (Gmail + Google Calendar)
├── index.ts          <- Prints a summary of endpoints
└── connect.ts        <- Google OAuth connection setup
ARCHITECTURE.md       <- YOUR ARCHITECTURE DOC (create this)
```

### How the runner works

1. `run.ts` loads endpoints from `endpoints.json` and passes them to your `runAgent()` function along with an authenticated Composio client.
2. Your `runAgent()` tests each endpoint and returns a `TestReport`.
3. `run.ts` validates the report (all endpoints covered, valid statuses, summary counts match) and writes `report.json`.

You can create additional files and modules — just keep `runAgent()` in `agent.ts` as the entry point.

## Output format

Your agent returns a `TestReport` (see `src/types.ts`). The report JSON looks like:

```json
{
  "timestamp": "2026-03-25T10:00:00.000Z",
  "total_endpoints": 16,
  "results": [
    {
      "tool_slug": "GMAIL_LIST_MESSAGES",
      "method": "GET",
      "path": "/gmail/v1/users/me/messages",
      "status": "valid",
      "http_status_code": 200,
      "response_summary": "Returned list of messages successfully",
      "response_body": { "messages": [{ "id": "19d1b2ff8f72b035", "threadId": "19d1b2fc48ac0f35" }], "resultSizeEstimate": 201 },
      "required_scopes": ["https://www.googleapis.com/auth/gmail.readonly"],
      "available_scopes": ["https://www.googleapis.com/auth/gmail.readonly"]
    }
  ],
  "summary": {
    "valid": 13,
    "invalid_endpoint": 2,
    "insufficient_scopes": 1,
    "error": 0
  }
}
```

Each result includes a `response_summary` field. A high-quality summary that explains **why** the endpoint was classified that way (not just the status code, but what the response indicated) is a bonus — think of it as a cherry on top.

## How to Submit

1. **Make sure `report.json` exists** — run `bun src/run.ts` and verify it passes validation.

2. **Make sure `ARCHITECTURE.md` exists** — this is required and will be used in scoring.

3. **Record a Loom video** (2–4 minutes) at [loom.com](https://loom.com) — explain your architecture, decisions, and tradeoffs.

4. **Submit:**
   ```bash
   sh upload.sh <your_email> <loom_video_url>
   ```
   This uploads your code, report, architecture doc, and agent session traces.

---

*We're evaluating how you think and build with an AI agent. A thoughtful architecture that generalizes is worth more than a perfect score on 16 sample endpoints.*
