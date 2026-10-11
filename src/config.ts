import { z } from "zod";
import { ServiceError } from "./errors.js";
import type { Env } from "./types.js";

const label = z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/);
const token = z
  .string()
  .min(32)
  .max(512)
  .refine((value) => !/\s/.test(value));
const tokensSchema = z
  .record(label, token)
  .refine((value) => Object.keys(value).length > 0);
const keysSchema = z
  .record(label, z.string().regex(/^tvly-[^\s]+$/))
  .refine((value) => {
    const values = Object.values(value);
    return (
      values.length > 0 &&
      values.length <= 20 &&
      new Set(values).size === values.length
    );
  });

function parseSecret<T>(schema: z.ZodType<T>, raw: string): T {
  try {
    return schema.parse(JSON.parse(raw));
  } catch {
    // Validation errors can contain secret values. Never expose or log them.
    throw new ServiceError(
      "CONFIGURATION_ERROR",
      "Server secrets are missing or invalid.",
      503,
    );
  }
}

export function readKeys(
  env: Pick<Env, "TAVILY_API_KEYS">,
): Record<string, string> {
  return parseSecret(keysSchema, env.TAVILY_API_KEYS);
}

export function readAuth(env: Pick<Env, "CLIENT_TOKENS" | "ADMIN_TOKEN">) {
  const clients = parseSecret(tokensSchema, env.CLIENT_TOKENS);
  const adminResult = token.safeParse(env.ADMIN_TOKEN);
  const values = Object.values(clients);
  if (
    !adminResult.success ||
    new Set([...values, env.ADMIN_TOKEN]).size !== values.length + 1
  ) {
    throw new ServiceError(
      "CONFIGURATION_ERROR",
      "Server secrets are missing or invalid.",
      503,
    );
  }
  return { clients, admin: adminResult.data };
}
