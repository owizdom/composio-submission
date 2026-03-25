import { Composio } from "@composio/core";
import endpoints from "./endpoints.json";
import { runAgent } from "./agent";
import type { EndpointDefinition, TestReport } from "./types";

/**
 * Runner script — do NOT modify this file.
 *
 * This script:
 *   1. Loads endpoint definitions from endpoints.json
 *   2. Calls your runAgent() implementation
 *   3. Validates the output format
 *   4. Writes the report to report.json
 *
 * Usage:
 *   bun src/run.ts
 */

const CONNECTED_ACCOUNT_ID = "candidate";

function flattenEndpoints(data: typeof endpoints): EndpointDefinition[] {
  const all: EndpointDefinition[] = [];
  for (const app of Object.values(data)) {
    for (const ep of (app as { endpoints: EndpointDefinition[] }).endpoints) {
      all.push(ep);
    }
  }
  return all;
}

function validateReport(
  report: TestReport,
  inputEndpoints: EndpointDefinition[]
): string[] {
  const errors: string[] = [];

  if (!report.timestamp) {
    errors.push("Missing timestamp");
  }

  if (report.total_endpoints !== inputEndpoints.length) {
    errors.push(
      `total_endpoints is ${report.total_endpoints}, expected ${inputEndpoints.length}`
    );
  }

  const inputSlugs = new Set(inputEndpoints.map((e) => e.tool_slug));
  const reportSlugs = new Set(report.results.map((r) => r.tool_slug));

  for (const slug of inputSlugs) {
    if (!reportSlugs.has(slug)) {
      errors.push(`Missing result for endpoint: ${slug}`);
    }
  }

  for (const result of report.results) {
    const validStatuses = [
      "valid",
      "invalid_endpoint",
      "insufficient_scopes",
      "error",
    ];
    if (!validStatuses.includes(result.status)) {
      errors.push(
        `Invalid status "${result.status}" for ${result.tool_slug}. Must be one of: ${validStatuses.join(", ")}`
      );
    }
    if (!("response_body" in result)) {
      errors.push(`Missing response_body for ${result.tool_slug}`);
    }
  }

  const summaryTotal =
    report.summary.valid +
    report.summary.invalid_endpoint +
    report.summary.insufficient_scopes +
    report.summary.error;
  if (summaryTotal !== report.results.length) {
    errors.push(
      `Summary counts (${summaryTotal}) don't match results length (${report.results.length})`
    );
  }

  return errors;
}

async function main() {
  console.log("Loading endpoint definitions...");
  const allEndpoints = flattenEndpoints(endpoints);
  console.log(`Found ${allEndpoints.length} endpoints to test.\n`);

  const composio = new Composio();

  console.log("Running agent...\n");
  const startTime = Date.now();

  const report = await runAgent({
    composio,
    connectedAccountId: CONNECTED_ACCOUNT_ID,
    endpoints: allEndpoints,
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nAgent completed in ${elapsed}s.`);

  // Validate the report
  const validationErrors = validateReport(report, allEndpoints);
  if (validationErrors.length > 0) {
    console.error("\n=== Report Validation Errors ===");
    for (const err of validationErrors) {
      console.error(`  ✗ ${err}`);
    }
    console.error(
      "\nYour report has issues. Fix them before submitting.\n"
    );
  } else {
    console.log("✓ Report validation passed.");
  }

  // Print summary
  console.log("\n=== Results Summary ===");
  console.log(`  Valid:               ${report.summary.valid}`);
  console.log(`  Invalid endpoint:    ${report.summary.invalid_endpoint}`);
  console.log(`  Insufficient scopes: ${report.summary.insufficient_scopes}`);
  console.log(`  Error:               ${report.summary.error}`);
  console.log(`  Total:               ${report.results.length}`);

  // Write report
  const reportPath = "report.json";
  await Bun.write(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`\nReport written to ${reportPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
