import { readAuth } from "./config.js";
import { ServiceError } from "./errors.js";
import type { Env } from "./types.js";

async function matches(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export async function authenticate(
  request: Request,
  env: Env,
  admin = false,
): Promise<string> {
  const config = readAuth(env);
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ") || header.length > 520) {
    throw new ServiceError(
      "UNAUTHORIZED",
      "A valid Bearer token is required.",
      401,
    );
  }
  const supplied = header.slice(7);
  if (admin) {
    if (await matches(supplied, config.admin)) return "admin";
  } else {
    for (const [client, expected] of Object.entries(config.clients)) {
      if (await matches(supplied, expected)) return client;
    }
  }
  throw new ServiceError(
    "UNAUTHORIZED",
    "A valid Bearer token is required.",
    401,
  );
}
