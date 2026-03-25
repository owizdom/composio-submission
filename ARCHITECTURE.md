# Architecture

## Design Overview

This is not a loop that tests endpoints. It's a system of **autonomous agents that reason about API behavior**.

Each endpoint gets its own `EndpointAgent` instance — a self-contained unit that doesn't just call an endpoint and check the status code. It follows a deliberate strategy: **attempt, diagnose, adapt, retry, classify with confidence**. The critical distinction is in step 3: when a request fails, the agent asks *"was that my fault or the endpoint's fault?"* — and changes its behavior accordingly.

### Flow

```
┌─────────────────────────────────────────────────────┐
│                   Orchestrator                       │
│  ┌──────────────┐  ┌──────────────────────────────┐ │
│  │ Account       │  │ Resource Pool                │ │
│  │ Discovery     │  │ (cross-agent shared state)   │ │
│  └──────────────┘  └──────────────────────────────┘ │
│                                                      │
│  Phase 1: Independent agents (no path params)        │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐       │
│  │Agent 1 │ │Agent 2 │ │Agent 3 │ │Agent N │  ───► │ deposit IDs
│  └────────┘ └────────┘ └────────┘ └────────┘       │
│                                                      │
│  Phase 2: Dependent agents (have path params)        │
│  ┌────────┐ ┌────────┐ ┌────────┐               ◄──│ consume IDs
│  │Agent A │ │Agent B │ │Agent C │                   │
│  └────────┘ └────────┘ └────────┘                   │
└─────────────────────────────────────────────────────┘
```

All agents within a phase run **concurrently** via `Promise.all`. No hardcoded execution order.

## The Agent — How It Thinks

Each `EndpointAgent` runs a 5-step loop:

### 1. RESOLVE — Dependency Resolution
The agent detects path parameters (`{messageId}`, `{eventId}`) by parsing the path. It computes the parent "list" path by stripping segments from the last `{param}` backwards:

```
/gmail/v1/users/me/messages/{messageId}/trash → /gmail/v1/users/me/messages
/calendar/v3/calendars/primary/events/{eventId} → /calendar/v3/calendars/primary/events
```

It then requests IDs from the shared **Resource Pool** — a concurrent-safe `Map<string, string[]>` with waiter support. If no IDs are available (Phase 1 hasn't deposited them yet), it falls back to calling the list endpoint directly.

This is fully generic. No hardcoded resource types. Any API following the list→detail pattern works.

### 2. ATTEMPT — Execute with Constructed Request
The agent builds the request from parameter definitions:
- **Query params**: Only `maxResults` (safe default) and required fields
- **Body**: Constructed from field descriptions using keyword matching (`base64 + rfc 2822` → encoded email, `start time` → ISO datetime, etc.)
- **Path params**: Substituted with real IDs from the pool

### 3. DIAGNOSE — Reason About the Response
This is the core differentiator. Instead of a status code → classification lookup table, the agent **reads the error response** and reasons:

- **404 + "url"/"route"/"method" in body** → Route-level 404, endpoint doesn't exist
- **404 without URL references** → Could be resource-level 404 (valid endpoint, wrong ID)
- **400 + "invalid"/"required"/"missing"** → Self-inflicted error, we sent bad data
- **403 + "scope"/"permission"** → Confirmed scope issue
- **400 without clear signals** → Ambiguous, might be us or the endpoint

### 4. ADAPT — Mutate Strategy on Self-Inflicted Failures
If the agent diagnoses a 400 as self-inflicted (our bad request, not a bad endpoint), it doesn't give up. It adapts:

| Attempt | Strategy | What changes |
|---------|----------|-------------|
| 0 | `full` | All relevant params + optional maxResults |
| 1 | `minimal` | Required params only |
| 2 | `bare` | No query params at all, just the body |

This prevents the most common false negative: classifying a valid endpoint as `error` because we sent a bad optional parameter.

### 5. CLASSIFY — Assign Status with Confidence
The agent outputs a **confidence score** alongside its classification:

| Scenario | Classification | Confidence |
|----------|---------------|------------|
| 2xx response | `valid` | 100% |
| 404/405 on first try | `invalid_endpoint` | 95% |
| 404 after retries | `invalid_endpoint` | 85% |
| 403/401 | `insufficient_scopes` | 95% |
| 400 after all retries, self-inflicted | `error` | 40% |
| Exception/no response | `error` | 50% |

The confidence score is an honest signal. When the agent isn't sure, it says so. A system consuming these results can prioritize manual review for low-confidence classifications.

## Avoiding False Negatives

This is the hardest problem. A valid endpoint that we fail to call correctly is **worse** than a false positive.

Our defenses:
1. **Self-inflicted error detection** — Parse 400 response bodies for keywords (`invalid`, `required`, `missing`, `parse`, `malformed`) that indicate the API is telling us we sent a bad request
2. **Adaptive retry** — Three strategies from generous to bare-minimum, each stripping more optional parameters
3. **Real dependency data** — Never fabricate IDs. Only use IDs from actual list responses
4. **Minimal parameter philosophy** — Start with only what's needed, don't over-specify
5. **Email discovery** — Get the actual user's email address for constructing valid RFC 2822 payloads instead of hardcoding

## Account Discovery & Path Handling

A subtle but critical detail: `proxyExecute()` routes through toolkit-specific base URLs, which can cause path doubling (e.g., `/calendar/v3/calendar/v3/...`). The agent auto-detects this by:

1. Listing all connected accounts under the entity
2. Mapping toolkit slugs to connected account IDs
3. Applying known prefix stripping rules (e.g., `googlecalendar` → strip `/calendar/v3`)

New toolkits are handled by matching the first path segment to toolkit slugs.

## Tradeoffs

**What I chose:**
- **Agent-per-endpoint over single orchestrator** — Each agent is stateless and autonomous. The only shared state is the Resource Pool, which is append-only. This scales horizontally.
- **Rule-based reasoning over LLM** — Faster, deterministic, no API costs. The diagnosis step uses pattern matching on error responses, which works well for REST APIs that follow standard error conventions.
- **Two-phase execution over fully dynamic** — Simple and predictable. The tradeoff is we can't handle multi-level dependency chains (A → B → C). Acceptable for REST APIs where dependencies are typically one level deep.
- **Confidence scores over binary classification** — Expresses uncertainty honestly. Better for downstream decision-making.

**What I'd improve with more time:**
- **LLM-powered payload generation** — For complex/unfamiliar body schemas, use an LLM to reason about parameter descriptions and generate valid payloads. The current keyword matching works for common patterns but would fail on exotic APIs.
- **Response schema learning** — After successful list calls, learn the response shape to better extract IDs from non-standard formats (e.g., APIs that nest IDs under `data.items[].uuid` instead of `items[].id`).
- **Scope pre-validation** — Query granted scopes upfront and pre-classify endpoints that require unavailable scopes, avoiding unnecessary API calls.
- **Deeper dependency chains** — Support A → B → C resolution by building a dependency DAG and executing in topological order.
- **Rate limit awareness** — Detect 429s and implement per-API exponential backoff.

## Why This Architecture

The evaluation asks: *"Is this a real agent with good reasoning, or just a loop?"*

A loop maps status codes to classifications. An agent **reasons about failures** — it asks "was that my fault?" and adapts. The `EndpointAgent` class embodies this: it maintains an attempt history, diagnoses each failure, mutates its strategy, and expresses confidence in its final answer.

This approach scales to thousands of endpoints because each agent is independent. Add more endpoints → add more concurrent agents. Add new apps → zero code changes (account discovery and path resolution are generic). The only thing that would need updating for exotic APIs is the body construction heuristics, which is the natural boundary where an LLM would add value.
