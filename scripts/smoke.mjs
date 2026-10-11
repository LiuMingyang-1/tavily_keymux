import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const { MCP_URL, MCP_TOKEN, SMOKE_QUERY } = process.env;
if (!MCP_URL || !MCP_TOKEN) {
  console.error(
    "Set MCP_URL and MCP_TOKEN. Optional SMOKE_QUERY performs a real, billable search.",
  );
  process.exit(1);
}

const endpoint = new URL(MCP_URL);
if (
  endpoint.protocol !== "https:" &&
  !(
    endpoint.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(endpoint.hostname)
  )
) {
  console.error("Use HTTPS, or HTTP on localhost for development.");
  process.exit(1);
}
if (endpoint.search || endpoint.username || endpoint.password) {
  console.error(
    "The MCP URL must not contain credentials or query parameters.",
  );
  process.exit(1);
}

const client = new Client({ name: "keymux-smoke", version: "0.1.0" });
try {
  await client.connect(
    new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
    }),
  );
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  if (!["web_search", "web_extract"].every((name) => names.includes(name)))
    throw new Error("Missing tools");
  console.log("Connected. Tools:", names.join(", "));
  if (SMOKE_QUERY) {
    const result = await client.callTool(
      { name: "web_search", arguments: { query: SMOKE_QUERY } },
      undefined,
      { timeout: 60_000 },
    );
    if (result.isError)
      throw new Error("Search failed; check administrator status");
    console.log(
      "Real search succeeded. Result count:",
      result.structuredContent?.results?.length ?? "unknown",
    );
  }
} catch {
  // SDK/network errors can contain request details. Keep terminal output secret-safe.
  console.error(
    "Smoke check failed. Verify endpoint, credentials, deployment, and administrator status.",
  );
  process.exitCode = 1;
} finally {
  await client.close();
}
