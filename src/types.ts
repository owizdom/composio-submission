/** A single endpoint definition as provided in endpoints.json */
export type EndpointDefinition = {
  tool_slug: string;
  description: string;
  method: string;
  path: string;
  required_scopes: string[];
  parameters: {
    query: ParameterDef[];
    path: ParameterDef[];
    body: {
      content_type: string;
      fields: ParameterDef[];
    } | null;
  };
};

export type ParameterDef = {
  name: string;
  type: string;
  required: boolean;
  description: string;
};

/**
 * Classification result for a single endpoint.
 *
 * - "valid" — Endpoint exists and returned a 2xx response (at least one successful call).
 * - "invalid_endpoint" — Endpoint does not exist (404, method not allowed, etc.).
 * - "insufficient_scopes" — Endpoint exists but account lacks permissions (403, forbidden).
 * - "error" — Something else went wrong (bad params, server error, timeout, etc.).
 */
export type EndpointStatus =
  | "valid"
  | "invalid_endpoint"
  | "insufficient_scopes"
  | "error";

/** Report for a single endpoint — one of these per endpoint tested */
export type EndpointReport = {
  tool_slug: string;
  method: string;
  path: string;
  status: EndpointStatus;
  http_status_code: number | null;
  /** Explain WHY this endpoint was classified this way — not just the status code. A high-quality summary is a bonus. */
  response_summary: string;
  /** The actual response body from the API call (or error message). Truncate large responses to a reasonable size and redact any sensitive personal data (emails, names, etc.). */
  response_body: unknown;
  required_scopes: string[];
  /** Scopes available on the connected account. Use [] if not determinable. */
  available_scopes: string[];
};

/** The full test report — this is what your agent returns */
export type TestReport = {
  timestamp: string;
  total_endpoints: number;
  results: EndpointReport[];
  summary: {
    valid: number;
    invalid_endpoint: number;
    insufficient_scopes: number;
    error: number;
  };
};
