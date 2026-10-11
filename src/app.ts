import { authenticate } from "./auth.js";
import { readKeys } from "./config.js";
import { publicError, ServiceError } from "./errors.js";
import { json, readJsonBody } from "./http.js";
import { handleMcp } from "./mcp.js";
import { TavilyProvider, type PoolService } from "./providers/tavily.js";
import { resetSchema } from "./schemas.js";
import type { Env } from "./types.js";

export async function handleApp(
  request: Request,
  env: Env,
  pool: PoolService,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      // Liveness only; never exposes configuration or contacts Tavily.
      return json({ status: "ok", service: "tavily-keymux" });
    }
    if (!["/mcp", "/admin/status", "/admin/reset"].includes(url.pathname))
      return json({ error: "Not found" }, 404);
    // Native clients and CLI bridges do not need browser CORS access.
    if (request.headers.has("Origin"))
      throw new ServiceError(
        "ORIGIN_NOT_ALLOWED",
        "Browser origins are not supported.",
        403,
      );
    if (url.search)
      throw new ServiceError(
        "INVALID_REQUEST",
        "Use headers for authentication; query parameters are not supported.",
        400,
      );
    await authenticate(request, env, url.pathname.startsWith("/admin/"));
    readKeys(env);
    if (url.pathname === "/admin/status" && request.method === "GET")
      return json(await pool.status());
    if (url.pathname === "/admin/reset" && request.method === "POST") {
      const parsed = resetSchema.safeParse(await readJsonBody(request));
      if (!parsed.success)
        throw new ServiceError("INVALID_INPUT", "Provide a valid key_id.", 400);
      if (!(await pool.reset(parsed.data.key_id)))
        return json({ error: "Unknown key_id" }, 404);
      return json({ reset: parsed.data.key_id });
    }
    if (url.pathname === "/mcp") {
      // Stateless MCP has no standalone GET stream or session to DELETE.
      if (request.method !== "POST")
        return json({ error: "Use POST for stateless MCP." }, 405, {
          Allow: "POST",
        });
      const body = await readJsonBody(request);
      const response = await handleMcp(request, new TavilyProvider(pool), body);
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
    return json({ error: "Method not allowed" }, 405, {
      Allow: url.pathname === "/admin/status" ? "GET" : "POST",
    });
  } catch (error) {
    const safe = publicError(error);
    const headers: Record<string, string> = {};
    if (safe.status === 401)
      headers["WWW-Authenticate"] = 'Bearer realm="tavily-keymux"';
    return json(
      { error: { code: safe.code, message: safe.message } },
      safe.status,
      headers,
    );
  }
}
