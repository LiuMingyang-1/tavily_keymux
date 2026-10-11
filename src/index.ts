import { json } from "./http.js";
import type { Env } from "./types.js";

export { TavilyKeyPool } from "./key-pool/object.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET")
      return json({ status: "ok", service: "tavily-keymux" });
    if (!["/mcp", "/admin/status", "/admin/reset"].includes(path))
      return json({ error: "Not found" }, 404);
    // Keep the Free-plan 10ms edge invocation small. The DO performs all auth,
    // JSON/schema work and provider I/O with its own CPU budget.
    try {
      const pool = env.KEY_POOL.get(
        env.KEY_POOL.idFromName("tavily-global-v1"),
      );
      return await pool.fetch(request);
    } catch {
      return json(
        {
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "The search service is temporarily unavailable.",
          },
        },
        503,
      );
    }
  },
} satisfies ExportedHandler<Env>;
