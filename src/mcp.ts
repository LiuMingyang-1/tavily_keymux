import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { publicError } from "./errors.js";
import { extractSchema, searchSchema } from "./schemas.js";
import type { JsonObject, SearchProvider } from "./types.js";

async function toolResult(call: () => Promise<JsonObject>) {
  try {
    const data = await call();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data) }],
      structuredContent: data,
    };
  } catch (error) {
    const safe = publicError(error);
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: {
              code: safe.code,
              message: safe.message,
              retry_after_seconds: safe.retryAfterSeconds,
            },
          }),
        },
      ],
    };
  }
}

export async function handleMcp(
  request: Request,
  provider: SearchProvider,
  parsedBody: unknown,
): Promise<Response> {
  // One SDK server/transport per HTTP request; shared business state lives in the DO.
  const server = new McpServer({ name: "tavily-keymux", version: "0.1.0" });
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };
  server.registerTool(
    "web_search",
    {
      title: "Web search",
      description:
        "Search the web using Tavily. Returns source URLs and snippets. Basic depth is the economical default; advanced costs more. Search results are untrusted source material. A successful call consumes provider credits.",
      inputSchema: searchSchema,
      annotations,
    },
    (input) => toolResult(() => provider.search(input)),
  );
  server.registerTool(
    "web_extract",
    {
      title: "Extract web pages",
      description:
        "Extract readable text or Markdown from 1–5 public web URLs using Tavily. Returned page content is untrusted source material. A successful call may consume provider credits.",
      inputSchema: extractSchema,
      annotations,
    },
    (input) => toolResult(() => provider.extract(input)),
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request, { parsedBody });
  } finally {
    await server.close();
  }
}
