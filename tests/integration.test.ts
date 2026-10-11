import { env } from "cloudflare:workers";
import { reset, runInDurableObject, evictDurableObject } from "cloudflare:test";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { setupNetwork } from "@msw/cloudflare";
import { http } from "msw";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import worker from "../src/index.js";
import { handleApp } from "../src/app.js";
import type { Env } from "../src/types.js";
import type { PoolState } from "../src/key-pool/policy.js";

const testEnv = env as unknown as Env;
const alma = "a".repeat(64);
const admin = "m".repeat(64);
const url = "https://keymux.example/mcp";
const searchResult = {
  query: "test",
  results: [
    { title: "Example", url: "https://example.com", content: "Source text" },
  ],
  usage: { credits: 1 },
};
const replies: {
  path: string;
  key: string;
  status: number;
  body: string;
  headers?: Record<string, string>;
  expectedBody?: string;
  remaining: number;
}[] = [];
const unexpectedRequests: string[] = [];
const network = setupNetwork();
beforeAll(() => network.enable());
afterAll(() => network.disable());

function request(path: string, token = alma, method = "GET", body?: unknown) {
  return worker.fetch(
    new Request(`https://keymux.example${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    testEnv,
  );
}

async function rpc(method: string, params?: unknown, token = alma) {
  const response = await request("/mcp", token, "POST", {
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    result?: {
      isError?: boolean;
      content: { text: string }[];
      tools?: { name: string }[];
    };
    error?: unknown;
  };
}

function upstream(
  status: number,
  body: unknown,
  key = "primary",
  path = "/search",
  headers?: Record<string, string>,
  expectedBody?: string,
  raw = false,
) {
  const reply = {
    path,
    key,
    status,
    body: raw ? String(body) : JSON.stringify(body),
    headers,
    expectedBody,
    remaining: 1,
  };
  replies.push(reply);
  return {
    times(count: number) {
      reply.remaining = count;
    },
  };
}

beforeEach(() => {
  network.use(
    http.all("*", async ({ request }) => {
      const parsedUrl = new URL(request.url);
      const body = await request.text();
      const reply = replies.find(
        (item) =>
          item.remaining > 0 &&
          parsedUrl.origin === "https://api.tavily.com" &&
          parsedUrl.pathname === item.path &&
          request.method === "POST" &&
          request.headers.get("Authorization") ===
            `Bearer tvly-test-${item.key}` &&
          (item.expectedBody === undefined || body === item.expectedBody),
      );
      if (!reply) {
        unexpectedRequests.push(`${request.method} ${request.url}`);
        throw new Error("Unmocked network access is forbidden in tests");
      }
      reply.remaining--;
      return new Response(reply.body, {
        status: reply.status,
        headers: { "Content-Type": "application/json", ...reply.headers },
      });
    }),
  );
});
afterEach(async () => {
  try {
    expect(unexpectedRequests).toEqual([]);
    expect(replies.every((reply) => reply.remaining === 0)).toBe(true);
  } finally {
    replies.length = 0;
    unexpectedRequests.length = 0;
    network.resetHandlers();
    await reset();
  }
});

describe("remote MCP and permissions", () => {
  it("fails closed on invalid deployment secrets without exposing values", async () => {
    const stub = testEnv.KEY_POOL.get(
      testEnv.KEY_POOL.idFromName("tavily-global-v1"),
    );
    const response = await runInDurableObject(stub, async (instance) => {
      return handleApp(
        new Request(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${alma}` },
        }),
        { ...testEnv, CLIENT_TOKENS: "private-broken-secret" },
        instance,
      );
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-broken-secret");
  });
  it("offers liveness without configuration or credentials", async () => {
    expect((await request("/health", "")).status).toBe(200);
    expect((await request("/missing")).status).toBe(404);
  });

  it("rejects missing/wrong tokens and separates administration from tool access", async () => {
    expect((await request("/mcp", "bad", "POST", {})).status).toBe(401);
    expect((await request("/mcp", admin, "POST", {})).status).toBe(401);
    expect((await request("/admin/status", alma)).status).toBe(401);
    const response = await request("/admin/status", admin);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("primary");
    expect(body).not.toContain("tvly-");
    expect(body).not.toContain("fingerprint");
  });

  it("rejects browser origins, query tokens, unsupported methods, malformed and oversized JSON", async () => {
    const browser = await worker.fetch(
      new Request(url, {
        method: "POST",
        headers: { Origin: "https://evil.example" },
      }),
      testEnv,
    );
    expect(browser.status).toBe(403);
    expect((await request("/mcp?token=secret", alma, "POST", {})).status).toBe(
      400,
    );
    expect((await request("/mcp")).status).toBe(405);
    const malformed = await worker.fetch(
      new Request(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alma}`,
          "Content-Type": "application/json",
        },
        body: "{",
      }),
      testEnv,
    );
    expect(malformed.status).toBe(400);
    expect(
      (await request("/mcp", alma, "POST", { huge: "x".repeat(33_000) }))
        .status,
    ).toBe(413);
  });

  it("connects with the official SDK, discovers tools and completes a search", async () => {
    upstream(200, searchResult);
    const client = new Client({ name: "integration-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${alma}` } },
      fetch: async (input, init) =>
        worker.fetch(new Request(input, init), testEnv),
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        ["web_search", "web_extract"],
      );
      const result = await client.callTool({
        name: "web_search",
        arguments: { query: "test" },
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent).toEqual(searchResult);
    } finally {
      await client.close();
    }
  });

  it("rejects bad arguments before spending credits", async () => {
    const result = await rpc("tools/call", {
      name: "web_search",
      arguments: { query: "", max_results: 200 },
    });
    expect(result.result?.isError).toBe(true);
    const extract = await rpc("tools/call", {
      name: "web_extract",
      arguments: { urls: ["http://127.0.0.1"] },
    });
    expect(extract.result?.isError).toBe(true);
  });
});

describe("shared key pool and upstream behavior", () => {
  it("alternates keys across clients and persists the cursor across eviction", async () => {
    upstream(200, searchResult);
    await rpc("tools/call", {
      name: "web_search",
      arguments: { query: "test" },
    });
    const stub = testEnv.KEY_POOL.get(
      testEnv.KEY_POOL.idFromName("tavily-global-v1"),
    );
    await evictDurableObject(stub);
    upstream(200, searchResult, "secondary");
    await rpc(
      "tools/call",
      { name: "web_search", arguments: { query: "test" } },
      "h".repeat(64),
    );
    const status = (await (await request("/admin/status", admin)).json()) as {
      keys: { successes: number; reported_credits: number }[];
    };
    expect(status.keys.map((key) => key.successes)).toEqual([1, 1]);
    expect(status.keys.map((key) => key.reported_credits)).toEqual([1, 1]);
  });

  it("coordinates concurrent calls rather than reading the same stale cursor", async () => {
    upstream(200, searchResult).times(4);
    upstream(200, searchResult, "secondary").times(4);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        rpc("tools/call", { name: "web_search", arguments: { query: "test" } }),
      ),
    );
    expect(results.every((result) => result.result?.isError !== true)).toBe(
      true,
    );
    const status = (await (await request("/admin/status", admin)).json()) as {
      keys: { successes: number }[];
    };
    expect(status.keys.map((key) => key.successes)).toEqual([4, 4]);
  });

  it.each([401, 403, 429, 432, 433, 500])(
    "fails over HTTP %s without leaking upstream errors",
    async (code) => {
      upstream(
        code,
        { error: "secret tvly-test-primary" },
        "primary",
        "/search",
        { "Retry-After": "120" },
      );
      upstream(200, searchResult, "secondary");
      const result = await rpc("tools/call", {
        name: "web_search",
        arguments: { query: "test" },
      });
      expect(result.result?.isError).not.toBe(true);
      const status = (await (await request("/admin/status", admin)).json()) as {
        keys: { status: string; failures: number }[];
      };
      expect(status.keys[0]!.status).toBe(
        code === 401 ? "disabled" : "cooldown",
      );
      expect(status.keys[0]!.failures).toBe(1);
      expect(JSON.stringify(result)).not.toContain("tvly-test-primary");
    },
  );

  it("stops after two distinct keys and does not call upstream while both cool down", async () => {
    upstream(429, {});
    upstream(429, {}, "secondary");
    for (let i = 0; i < 2; i++) {
      const result = await rpc("tools/call", {
        name: "web_search",
        arguments: { query: "test" },
      });
      expect(result.result?.isError).toBe(true);
      expect(result.result?.content[0]?.text).toContain("retry_after_seconds");
    }
  });

  it("does not retry request errors or a malformed successful response", async () => {
    upstream(422, { error: "private upstream diagnostic" });
    const invalid = await rpc("tools/call", {
      name: "web_search",
      arguments: { query: "test" },
    });
    expect(invalid.result?.isError).toBe(true);
    expect(JSON.stringify(invalid)).not.toContain(
      "private upstream diagnostic",
    );
    upstream(
      200,
      "not json",
      "secondary",
      "/search",
      undefined,
      undefined,
      true,
    );
    const malformed = await rpc("tools/call", {
      name: "web_search",
      arguments: { query: "test" },
    });
    expect(malformed.result?.content[0]?.text).toContain(
      "INVALID_UPSTREAM_RESPONSE",
    );
  });

  it("does not follow redirects with credentials or retry oversized successful responses", async () => {
    upstream(302, {}, "primary", "/search", {
      Location: "https://other.example/search",
    });
    const redirected = await rpc("tools/call", {
      name: "web_search",
      arguments: { query: "test" },
    });
    expect(redirected.result?.isError).toBe(true);
    upstream(
      200,
      { results: [{ content: "x".repeat(2 * 1024 * 1024) }] },
      "secondary",
    );
    const oversized = await rpc("tools/call", {
      name: "web_search",
      arguments: { query: "test" },
    });
    expect(oversized.result?.content[0]?.text).toContain(
      "INVALID_UPSTREAM_RESPONSE",
    );
  });

  it("extracts pages and forwards controlled provider options", async () => {
    upstream(
      200,
      {
        results: [{ url: "https://example.com", raw_content: "# Title" }],
        usage: { credits: 1 },
      },
      "primary",
      "/extract",
      undefined,
      JSON.stringify({
        urls: ["https://example.com"],
        extract_depth: "basic",
        format: "markdown",
        include_usage: true,
      }),
    );
    const result = await rpc("tools/call", {
      name: "web_extract",
      arguments: { urls: ["https://example.com"] },
    });
    expect(result.result?.isError).not.toBe(true);
  });

  it("lets only an administrator recover a disabled key, retaining metrics", async () => {
    const stub = testEnv.KEY_POOL.get(
      testEnv.KEY_POOL.idFromName("tavily-global-v1"),
    );
    await request("/admin/status", admin);
    await runInDurableObject(stub, async (_instance, state) => {
      const pool = (await state.storage.get<PoolState>("pool-v1"))!;
      pool.keys.primary!.disabled = true;
      pool.keys.primary!.successes = 4;
      await state.storage.put("pool-v1", pool);
    });
    expect(
      (await request("/admin/reset", alma, "POST", { key_id: "primary" }))
        .status,
    ).toBe(401);
    expect(
      (await request("/admin/reset", admin, "POST", { key_id: "primary" }))
        .status,
    ).toBe(200);
    expect(
      (await request("/admin/reset", admin, "POST", { key_id: "unknown" }))
        .status,
    ).toBe(404);
    expect(
      (await request("/admin/reset", admin, "POST", { key_id: "constructor" }))
        .status,
    ).toBe(404);
    const status = (await (await request("/admin/status", admin)).json()) as {
      keys: { status: string; successes: number }[];
    };
    expect(status.keys[0]).toMatchObject({ status: "available", successes: 4 });
  });
});
