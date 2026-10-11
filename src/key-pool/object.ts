import { DurableObject } from "cloudflare:workers";
import { handleApp } from "../app.js";
import { readKeys } from "../config.js";
import { extractSchema, searchSchema } from "../schemas.js";
import type { Env, JsonObject, TavilyOperation } from "../types.js";
import {
  classifyFailure,
  emptyKey,
  reconcile,
  selectKey,
  type FailureAction,
  type PoolState,
} from "./policy.js";

const STATE_KEY = "pool-v1";
// Distinct keys tried per request. Kept small so failures on free-plan keys
// can't fan a single client request out across the whole pool.
const MAX_KEY_ATTEMPTS = 3;
const UPSTREAM_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type ExecutionResult =
  | { ok: true; data: JsonObject }
  | { ok: false; code: string; message: string; retryAfterSeconds?: number };

async function fingerprint(secret: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function readResponse(response: Response): Promise<JsonObject> {
  if (!response.body) throw new Error("Empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error("Response too large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid response");
  return value as JsonObject;
}

/** All Worker locations address the same object. Secrets never leave this boundary. */
export class TavilyKeyPool extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    return handleApp(request, this.env, this);
  }

  private async credentials() {
    const keys = readKeys(this.env);
    const fingerprints = Object.fromEntries(
      await Promise.all(
        Object.entries(keys).map(
          async ([id, key]) => [id, await fingerprint(key)] as const,
        ),
      ),
    );
    return { keys, fingerprints };
  }

  private async update<T>(
    fingerprints: Record<string, string>,
    change: (state: PoolState) => T,
  ): Promise<T> {
    return this.ctx.storage.transaction(async (storage) => {
      const state = reconcile(
        await storage.get<PoolState>(STATE_KEY),
        fingerprints,
      );
      const result = change(state);
      await storage.put(STATE_KEY, state);
      return result;
    });
  }

  async execute(
    operation: TavilyOperation,
    input: JsonObject,
  ): Promise<ExecutionResult> {
    const validation = (
      operation === "search" ? searchSchema : extractSchema
    ).safeParse(input);
    if (!validation.success || !["search", "extract"].includes(operation)) {
      return {
        ok: false,
        code: "INVALID_INPUT",
        message: "Invalid tool arguments.",
      };
    }
    const { keys, fingerprints } = await this.credentials();
    const tried: string[] = [];
    let lastFailure: FailureAction | undefined;
    for (
      let attempt = 0;
      attempt < Math.min(MAX_KEY_ATTEMPTS, Object.keys(keys).length);
      attempt++
    ) {
      const id = await this.update(fingerprints, (state) =>
        selectKey(state, tried, Date.now()),
      );
      if (!id) break;
      tried.push(id);
      let response: Response;
      let action: FailureAction;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
      try {
        response = await fetch(`https://api.tavily.com/${operation}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${keys[id]!}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ...validation.data,
            include_usage: true,
            ...(operation === "search" ? { auto_parameters: false } : {}),
          }),
          // Workers supports manual/follow; never follow redirects with provider credentials.
          redirect: "manual",
          signal: controller.signal,
        });
      } catch {
        clearTimeout(timeout);
        action = classifyFailure(0, null, Date.now());
        await this.recordFailure(fingerprints, id, action);
        lastFailure = action;
        continue;
      }

      if (response.ok) {
        let data: JsonObject;
        try {
          data = await readResponse(response);
        } catch {
          // The provider may already have charged. Do not retry malformed/oversized successes.
          return {
            ok: false,
            code: "INVALID_UPSTREAM_RESPONSE",
            message:
              "Tavily returned an unreadable or oversized result. Try fewer URLs/results.",
          };
        } finally {
          clearTimeout(timeout);
        }
        const usage = data.usage as { credits?: unknown } | undefined;
        const credits =
          typeof usage?.credits === "number" &&
          Number.isFinite(usage.credits) &&
          usage.credits >= 0
            ? usage.credits
            : 0;
        await this.update(fingerprints, (state) => {
          const key = state.keys[id]!;
          key.successes++;
          key.reportedCredits += credits;
          // Never clear a concurrent failure's cooldown on an older successful request.
        });
        return { ok: true, data };
      }

      clearTimeout(timeout);
      action = classifyFailure(
        response.status,
        response.headers.get("Retry-After"),
        Date.now(),
      );
      await response.body?.cancel().catch(() => undefined);
      await this.recordFailure(fingerprints, id, action);
      lastFailure = action;
      if (!action.retry) {
        return {
          ok: false,
          code: action.code,
          message: `Tavily rejected the request (HTTP ${response.status}). Check the tool arguments.`,
        };
      }
    }

    const retryAfterSeconds = await this.update(fingerprints, (state) => {
      const deadlines = Object.values(state.keys)
        .filter((key) => !key.disabled && key.blockedUntil > Date.now())
        .map((key) => key.blockedUntil);
      return deadlines.length
        ? Math.max(1, Math.ceil((Math.min(...deadlines) - Date.now()) / 1000))
        : undefined;
    });
    return {
      ok: false,
      code: lastFailure?.code ?? "NO_AVAILABLE_KEYS",
      message:
        "No Tavily key could complete the request. Keys may be cooling down, exhausted, or disabled; ask the administrator to check status.",
      retryAfterSeconds,
    };
  }

  private async recordFailure(
    fingerprints: Record<string, string>,
    id: string,
    action: FailureAction,
  ) {
    await this.update(fingerprints, (state) => {
      const key = state.keys[id]!;
      key.failures++;
      key.reason = action.code;
      if (action.disabled) key.disabled = true;
      if (action.blockedUntil)
        key.blockedUntil = Math.max(key.blockedUntil, action.blockedUntil);
    });
  }

  async status() {
    const { fingerprints } = await this.credentials();
    return this.update(fingerprints, (state) => ({
      provider: "tavily",
      keys: Object.entries(state.keys).map(([id, key]) => ({
        id,
        status: key.disabled
          ? "disabled"
          : key.blockedUntil > Date.now()
            ? "cooldown"
            : "available",
        blocked_until:
          key.blockedUntil > Date.now()
            ? new Date(key.blockedUntil).toISOString()
            : null,
        last_failure: key.reason ?? null,
        successes: key.successes,
        failures: key.failures,
        reported_credits: key.reportedCredits,
      })),
      credits_note:
        "Observed credits reported by successful API responses, not the account balance or a monthly counter.",
    }));
  }

  async reset(id: string): Promise<boolean> {
    const { fingerprints } = await this.credentials();
    return this.update(fingerprints, (state) => {
      const key = state.keys[id];
      if (!Object.hasOwn(state.keys, id) || !key) return false;
      const fresh = emptyKey(key.fingerprint);
      state.keys[id] = {
        ...fresh,
        successes: key.successes,
        failures: key.failures,
        reportedCredits: key.reportedCredits,
      };
      return true;
    });
  }
}
