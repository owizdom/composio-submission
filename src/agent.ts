import { Composio } from "@composio/core";
import type {
  EndpointDefinition,
  EndpointReport,
  EndpointStatus,
  TestReport,
} from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Endpoint Executability Validator — Autonomous Agent Architecture
//
// Each endpoint is validated by its own EndpointAgent instance. Agents
// reason about failures, adapt their request strategy, and express
// confidence in their classification. A shared ResourcePool enables
// cross-agent dependency resolution without hardcoded ordering.
// ═══════════════════════════════════════════════════════════════════════════

// ── Resource Pool (cross-agent shared state) ────────────────────────────
// List-type agents deposit discovered IDs. Detail-type agents consume them.
// Waiters allow dependent agents to block until data arrives, with timeout.

type ResourcePool = {
  store: Map<string, string[]>;
  waiters: Map<string, Array<(ids: string[]) => void>>;
};

function createPool(): ResourcePool {
  return { store: new Map(), waiters: new Map() };
}

function deposit(pool: ResourcePool, key: string, ids: string[]) {
  const merged = [...new Set([...(pool.store.get(key) ?? []), ...ids])];
  pool.store.set(key, merged);
  const waiting = pool.waiters.get(key);
  if (waiting) {
    for (const fn of waiting) fn(merged);
    pool.waiters.delete(key);
  }
}

function request(pool: ResourcePool, key: string, ms = 30000): Promise<string[] | null> {
  const hit = pool.store.get(key);
  if (hit?.length) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    const w = pool.waiters.get(key) ?? [];
    w.push((ids) => { clearTimeout(t); resolve(ids); });
    pool.waiters.set(key, w);
  });
}

// ── Account Discovery ───────────────────────────────────────────────────

type AcctInfo = { id: string; strip: string };

const TOOLKIT_PREFIXES: Record<string, string> = {
  googlecalendar: "/calendar/v3",
};

async function discoverAccounts(composio: Composio, entity: string): Promise<Map<string, AcctInfo>> {
  const map = new Map<string, AcctInfo>();
  try {
    const { items } = await composio.connectedAccounts.list({ userIds: [entity] });
    for (const a of items) {
      const slug = (a as any).toolkit?.slug ?? (a as any).toolkit ?? "";
      if (a.status === "ACTIVE" && !map.has(slug)) {
        map.set(slug, { id: a.id, strip: TOOLKIT_PREFIXES[slug] ?? "" });
      }
    }
  } catch {}
  return map;
}

function resolveAccount(path: string, map: Map<string, AcctInfo>): AcctInfo | null {
  if (path.startsWith("/gmail/")) return map.get("gmail") ?? null;
  if (path.startsWith("/calendar/")) return map.get("googlecalendar") ?? null;
  // Generic: try first path segment
  const seg = path.split("/").filter(Boolean)[0];
  if (seg) for (const [k, v] of map) if (k.includes(seg.toLowerCase())) return v;
  return map.values().next().value ?? null;
}

// ── Utilities ───────────────────────────────────────────────────────────

function pathParams(p: string): string[] {
  return (p.match(/\{(\w+)\}/g) ?? []).map((m) => m.slice(1, -1));
}

function parentPath(p: string): string {
  const parts = p.split("/");
  for (let i = parts.length - 1; i >= 0; i--)
    if (parts[i].includes("{")) return parts.slice(0, i).join("/");
  return p;
}

function extractIds(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const ids: string[] = [];
  for (const v of Object.values(data as Record<string, unknown>)) {
    if (!Array.isArray(v)) continue;
    for (const item of v.slice(0, 10)) {
      if (typeof item === "object" && item && typeof (item as any).id === "string")
        ids.push((item as any).id);
    }
    if (ids.length) break;
  }
  return [...new Set(ids)];
}

function truncate(data: unknown): unknown {
  const s = JSON.stringify(data);
  if (!s || s.length <= 5000) return data;
  if (typeof data === "object" && data !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (Array.isArray(v) && JSON.stringify(v).length > 2000) {
        out[k] = v.slice(0, 3);
        out[`_${k}_note`] = `Showing 3 of ${v.length}`;
      } else out[k] = v;
    }
    return out;
  }
  return String(s).slice(0, 5000) + "...[truncated]";
}

// ── Proxy Execution ─────────────────────────────────────────────────────

async function exec(
  composio: Composio,
  acct: AcctInfo,
  endpoint: string,
  method: string,
  params?: Array<{ in: "query"; name: string; value: unknown }>,
  body?: Record<string, unknown>
): Promise<{ status: number | null; data: unknown }> {
  let ep = endpoint;
  if (acct.strip && ep.startsWith(acct.strip)) ep = ep.slice(acct.strip.length);

  const opts: any = {
    endpoint: ep,
    method: method as "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
    connectedAccountId: acct.id,
  };
  if (params?.length) opts.parameters = params;
  if (body && ["POST", "PUT", "PATCH"].includes(method)) opts.body = body;

  const r = await composio.tools.proxyExecute(opts);
  return { status: (r as any)?.status ?? null, data: (r as any)?.data ?? r };
}

// ═══════════════════════════════════════════════════════════════════════════
// EndpointAgent — the core reasoning unit
//
// Each instance is an autonomous agent responsible for validating one
// endpoint. It follows a multi-step strategy:
//
//   1. RESOLVE  — Resolve path parameter dependencies from the pool
//   2. ATTEMPT  — Execute the endpoint with constructed params/body
//   3. ANALYZE  — Reason about the response to determine classification
//   4. ADAPT    — If the failure looks self-inflicted, mutate strategy & retry
//   5. CLASSIFY — Assign status with a confidence score
//
// The agent distinguishes between "the endpoint is broken" and "I broke
// the request" by analyzing error response patterns, which is the key
// differentiator between an agent and a loop.
// ═══════════════════════════════════════════════════════════════════════════

type Attempt = {
  strategy: string;
  httpStatus: number | null;
  data: unknown;
  diagnosis: string;
};

class EndpointAgent {
  private attempts: Attempt[] = [];
  private maxRetries = 2;

  constructor(
    private composio: Composio,
    private ep: EndpointDefinition,
    private allEndpoints: EndpointDefinition[],
    private pool: ResourcePool,
    private acctMap: Map<string, AcctInfo>,
    private userEmail: string
  ) {}

  async run(): Promise<EndpointReport & { confidence: number }> {
    const acct = resolveAccount(this.ep.path, this.acctMap);
    if (!acct) return this.report("error", null, null, "No connected account found.", 0);

    // ── Step 1: Resolve path parameters ────────────────────────────
    const params = pathParams(this.ep.path);
    let resolvedPath = this.ep.path;

    if (params.length > 0) {
      const listPath = parentPath(this.ep.path);
      let ids = await request(this.pool, listPath, 5000);

      // Fallback: fetch the list endpoint ourselves
      if (!ids?.length) {
        const listAcct = resolveAccount(listPath, this.acctMap);
        if (listAcct) {
          try {
            const r = await exec(this.composio, listAcct, listPath, "GET",
              [{ in: "query", name: "maxResults", value: 5 }]);
            if (r.status && r.status >= 200 && r.status < 300) {
              const extracted = extractIds(r.data);
              if (extracted.length) { deposit(this.pool, listPath, extracted); ids = extracted; }
            }
          } catch {}
        }
      }

      if (ids?.length) {
        for (const p of params) resolvedPath = resolvedPath.replace(`{${p}}`, ids[0]);
      } else {
        return this.report("error", null, null,
          `Cannot resolve path params [${params.join(", ")}]: no list data available. ` +
          `Endpoint may be valid but untestable without dependency data.`, 0.3);
      }
    }

    // ── Step 2–4: Attempt → Analyze → Adapt loop ──────────────────
    let lastAttempt: Attempt | null = null;

    for (let i = 0; i <= this.maxRetries; i++) {
      const strategy = this.pickStrategy(i);
      const { queryParams, body } = this.buildRequest(strategy);

      let status: number | null = null;
      let data: unknown = null;

      try {
        const r = await exec(this.composio, acct, resolvedPath, this.ep.method, queryParams, body);
        status = r.status;
        data = r.data;
      } catch (err: any) {
        lastAttempt = { strategy, httpStatus: null, data: err.message, diagnosis: "Exception thrown" };
        this.attempts.push(lastAttempt);
        continue;
      }

      const diagnosis = this.diagnose(status, data, strategy);
      lastAttempt = { strategy, httpStatus: status, data, diagnosis };
      this.attempts.push(lastAttempt);

      // Deposit IDs from successful list responses
      if (status && status >= 200 && status < 300 && params.length === 0) {
        const ids = extractIds(data);
        if (ids.length) deposit(this.pool, this.ep.path, ids);
      }

      // ── Decide: accept result or adapt and retry ───────────────
      if (status !== null && status >= 200 && status < 300) break; // Success — done
      if (status === 404 || status === 405) break; // Definitive: endpoint doesn't exist
      if (status === 403 || status === 401) break; // Definitive: scope issue
      if (status === 501) break; // Not implemented

      // 400 = ambiguous. Could be our fault. Analyze and adapt.
      if (status === 400 && i < this.maxRetries) {
        const selfInflicted = this.isSelfInflicted(data);
        if (selfInflicted) continue; // retry with adapted strategy
        break; // API says our request is bad in a way we can't fix
      }

      // 500+ = server error, unlikely to improve with retry
      if (status && status >= 500) break;
    }

    // ── Step 5: Classify with confidence ─────────────────────────
    return this.classifyWithConfidence(lastAttempt!);
  }

  // ── Strategy Selection ──────────────────────────────────────────

  private pickStrategy(attempt: number): string {
    switch (attempt) {
      case 0: return "full";          // All relevant params + body
      case 1: return "minimal";       // Required params only, no optionals
      case 2: return "bare";          // Absolute minimum — no query params at all
      default: return "bare";
    }
  }

  // ── Request Construction ────────────────────────────────────────

  private buildRequest(strategy: string): {
    queryParams: Array<{ in: "query"; name: string; value: unknown }>;
    body: Record<string, unknown> | undefined;
  } {
    const queryParams: Array<{ in: "query"; name: string; value: unknown }> = [];

    if (strategy !== "bare") {
      for (const q of this.ep.parameters.query) {
        const include = strategy === "full" ? (q.required || q.name === "maxResults") : q.required;
        if (include) {
          if (q.name === "maxResults") queryParams.push({ in: "query", name: q.name, value: 5 });
          else if (q.type === "integer" || q.type === "number") queryParams.push({ in: "query", name: q.name, value: 1 });
          else if (q.type === "boolean") queryParams.push({ in: "query", name: q.name, value: true });
          else queryParams.push({ in: "query", name: q.name, value: "test" });
        }
      }
    }

    const body = this.buildBody();
    return { queryParams, body };
  }

  private buildBody(): Record<string, unknown> | undefined {
    if (!this.ep.parameters.body) return undefined;
    const body: Record<string, unknown> = {};

    for (const f of this.ep.parameters.body.fields) {
      const desc = f.description.toLowerCase();

      if (f.type === "string" && desc.includes("base64") && desc.includes("rfc 2822")) {
        body[f.name] = this.encodeEmail("Endpoint Validation Test", "Automated test.");
      } else if (f.type === "object" && f.name === "message") {
        body[f.name] = { raw: this.encodeEmail("Draft Validation Test", "Automated draft.") };
      } else if (f.type === "object" && desc.includes("start time")) {
        body[f.name] = { dateTime: new Date(Date.now() + 3600000).toISOString(), timeZone: "UTC" };
      } else if (f.type === "object" && desc.includes("end time")) {
        body[f.name] = { dateTime: new Date(Date.now() + 7200000).toISOString(), timeZone: "UTC" };
      } else if (f.type === "string" && f.name === "summary") {
        body[f.name] = "Endpoint Validation Test Event";
      } else if (f.type === "string" && f.name === "description") {
        body[f.name] = "Automated validation test";
      } else if (f.required) {
        if (f.type === "string") body[f.name] = "test";
        else if (f.type === "integer" || f.type === "number") body[f.name] = 1;
        else if (f.type === "boolean") body[f.name] = true;
        else if (f.type === "object") body[f.name] = {};
        else if (f.type === "array") body[f.name] = [];
      }
    }

    return Object.keys(body).length ? body : undefined;
  }

  private encodeEmail(subject: string, text: string): string {
    const msg = [
      `From: ${this.userEmail}`,
      `To: ${this.userEmail}`,
      `Subject: ${subject}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      text,
    ].join("\r\n");
    return Buffer.from(msg).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  // ── Response Diagnosis ──────────────────────────────────────────
  // This is where the agent REASONS about what happened, rather than
  // blindly mapping status codes.

  private diagnose(status: number | null, data: unknown, strategy: string): string {
    if (status === null) return "No response received. Network or proxy error.";
    if (status >= 200 && status < 300) return "Success. Endpoint is valid and responding.";

    const body = JSON.stringify(data ?? "").toLowerCase();

    if (status === 404) {
      // Is this a real 404 (endpoint doesn't exist) or did we send a bad resource ID?
      if (body.includes("not found") && (body.includes("method") || body.includes("url") || body.includes("route"))) {
        return "Route-level 404: The API path itself is not recognized. This endpoint does not exist.";
      }
      if (body.includes("not found") && !body.includes("url")) {
        // Could be a resource-level 404 (valid endpoint, wrong ID)
        // But since we use real IDs from list endpoints, this is unlikely
        return "Resource-level 404: The path exists but the specific resource was not found. " +
               "Since we used IDs from a list call, this likely means the endpoint route doesn't exist.";
      }
      return "404 response. Endpoint likely does not exist.";
    }

    if (status === 403 || status === 401) {
      if (body.includes("scope") || body.includes("permission") || body.includes("insufficient") || body.includes("forbidden")) {
        return `Auth failure (${status}): Insufficient scopes. The endpoint exists but the account ` +
               `lacks required permissions: ${this.ep.required_scopes.join(", ")}.`;
      }
      return `Auth failure (${status}): Access denied. Likely a scope/permission issue.`;
    }

    if (status === 400) {
      if (body.includes("invalid") && (body.includes("param") || body.includes("field") || body.includes("value"))) {
        return `Bad request (400): The API rejected our parameters. This is likely a self-inflicted error ` +
               `(strategy: ${strategy}) — the endpoint probably exists but we sent wrong data.`;
      }
      if (body.includes("required")) {
        return `Bad request (400): Missing required field. Self-inflicted — endpoint likely valid.`;
      }
      return `Bad request (400): Request was rejected. Could be self-inflicted or a genuinely invalid payload format.`;
    }

    if (status === 405) return "Method not allowed (405): The HTTP method is wrong for this path. Endpoint may not exist with this method.";
    if (status === 501) return "Not implemented (501): Server does not support this operation. Endpoint does not exist.";
    if (status >= 500) return `Server error (${status}): The API had an internal error. Endpoint may exist but is broken.`;

    return `Unexpected status ${status}. Unable to determine cause.`;
  }

  // ── Self-Inflicted Error Detection ──────────────────────────────
  // Determines if a failure was caused by OUR bad request vs the endpoint
  // being genuinely invalid. This is the key insight that prevents false negatives.

  private isSelfInflicted(data: unknown): boolean {
    const body = JSON.stringify(data ?? "").toLowerCase();
    return (
      body.includes("invalid") ||
      body.includes("required") ||
      body.includes("missing") ||
      body.includes("parse") ||
      body.includes("malformed") ||
      body.includes("bad request") ||
      body.includes("validation")
    );
  }

  // ── Classification with Confidence ──────────────────────────────

  private classifyWithConfidence(attempt: Attempt): EndpointReport & { confidence: number } {
    const { httpStatus, data, diagnosis } = attempt;
    let status: EndpointStatus;
    let confidence: number;

    if (httpStatus === null) {
      status = "error";
      confidence = 0.5;
    } else if (httpStatus >= 200 && httpStatus < 300) {
      status = "valid";
      confidence = 1.0;
    } else if (httpStatus === 404 || httpStatus === 405 || httpStatus === 501) {
      status = "invalid_endpoint";
      // Lower confidence if we had retries (might be our fault)
      confidence = this.attempts.length === 1 ? 0.95 : 0.85;
    } else if (httpStatus === 403 || httpStatus === 401) {
      status = "insufficient_scopes";
      confidence = 0.95;
    } else if (httpStatus === 400) {
      // 400 is the hardest — was it us or the endpoint?
      const selfInflicted = this.isSelfInflicted(data);
      if (selfInflicted && this.attempts.length > 1) {
        // We tried multiple strategies and still got 400. The endpoint probably
        // exists but we can't figure out the right request format.
        status = "error";
        confidence = 0.4; // Low confidence — honest about uncertainty
      } else {
        status = "error";
        confidence = 0.6;
      }
    } else {
      status = "error";
      confidence = 0.5;
    }

    // Build rich summary with reasoning chain
    const strategies = this.attempts.map((a) => `[${a.strategy}→${a.httpStatus}]`).join(" → ");
    const summary =
      `${diagnosis} | Attempts: ${this.attempts.length} (${strategies}) | ` +
      `Confidence: ${(confidence * 100).toFixed(0)}%`;

    return {
      tool_slug: this.ep.tool_slug,
      method: this.ep.method,
      path: this.ep.path,
      status,
      http_status_code: httpStatus,
      response_summary: summary,
      response_body: truncate(data),
      required_scopes: this.ep.required_scopes,
      available_scopes: [],
      confidence,
    };
  }

  private report(
    status: EndpointStatus,
    httpStatus: number | null,
    data: unknown,
    summary: string,
    confidence: number
  ): EndpointReport & { confidence: number } {
    return {
      tool_slug: this.ep.tool_slug,
      method: this.ep.method,
      path: this.ep.path,
      status,
      http_status_code: httpStatus,
      response_summary: `${summary} | Confidence: ${(confidence * 100).toFixed(0)}%`,
      response_body: truncate(data),
      required_scopes: this.ep.required_scopes,
      available_scopes: [],
      confidence,
    };
  }
}

// ── User Email Discovery ────────────────────────────────────────────────

async function discoverEmail(composio: Composio, acctMap: Map<string, AcctInfo>): Promise<string> {
  const gmail = acctMap.get("gmail");
  if (gmail) {
    try {
      const r = await exec(composio, gmail, "/gmail/v1/users/me/profile", "GET");
      if (r.status === 200 && r.data && typeof r.data === "object")
        return (r.data as any).emailAddress ?? "test@example.com";
    } catch {}
  }
  return "test@example.com";
}

// ═══════════════════════════════════════════════════════════════════════════
// runAgent — Orchestrator
//
// Spawns an EndpointAgent per endpoint across two phases:
//   Phase 1: Independent endpoints (no path params) — populate resource pool
//   Phase 2: Dependent endpoints (have path params) — consume from pool
//
// All agents within a phase run concurrently. No hardcoded execution order.
// ═══════════════════════════════════════════════════════════════════════════

export async function runAgent(params: {
  composio: Composio;
  connectedAccountId: string;
  endpoints: EndpointDefinition[];
}): Promise<TestReport> {
  const { composio, connectedAccountId, endpoints } = params;
  const pool = createPool();

  console.log("Discovering connected accounts...");
  const acctMap = await discoverAccounts(composio, connectedAccountId);
  console.log(`Accounts: ${[...acctMap.entries()].map(([k, v]) => `${k}=${v.id}`).join(", ")}`);

  const userEmail = await discoverEmail(composio, acctMap);
  console.log(`User: ${userEmail}\n`);

  const independent = endpoints.filter((e) => pathParams(e.path).length === 0);
  const dependent = endpoints.filter((e) => pathParams(e.path).length > 0);
  console.log(`Endpoints: ${endpoints.length} total (${independent.length} independent, ${dependent.length} dependent)\n`);

  const runPhase = async (phase: string, eps: EndpointDefinition[]) => {
    console.log(`── ${phase} ──`);
    return Promise.all(
      eps.map(async (ep) => {
        const agent = new EndpointAgent(composio, ep, endpoints, pool, acctMap, userEmail);
        const result = await agent.run();
        const icon = result.status === "valid" ? "✓" : result.status === "invalid_endpoint" ? "✗" : "⚠";
        console.log(
          `  ${icon} ${result.status.padEnd(20)} HTTP ${String(result.http_status_code).padEnd(4)} ` +
          `[${(result.confidence * 100).toFixed(0)}%] ${ep.tool_slug}`
        );
        return result;
      })
    );
  };

  const phase1 = await runPhase("Phase 1: Independent", independent);
  const phase2 = await runPhase("Phase 2: Dependent", dependent);
  const results = [...phase1, ...phase2];

  const summary = { valid: 0, invalid_endpoint: 0, insufficient_scopes: 0, error: 0 };
  for (const r of results) summary[r.status]++;

  // Strip confidence from results (not part of TestReport type, but useful in logs)
  const cleanResults: EndpointReport[] = results.map(({ confidence, ...rest }) => rest);

  return {
    timestamp: new Date().toISOString(),
    total_endpoints: endpoints.length,
    results: cleanResults,
    summary,
  };
}
