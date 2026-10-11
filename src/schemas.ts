import { z } from "zod";

const domain = z
  .string()
  .min(1)
  .max(253)
  .regex(/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/);

export const searchSchema = z
  .object({
    query: z.string().trim().min(1).max(2000),
    search_depth: z.enum(["basic", "advanced"]).default("basic"),
    max_results: z.number().int().min(1).max(20).default(5),
    topic: z.enum(["general", "news", "finance"]).default("general"),
    time_range: z.enum(["day", "week", "month", "year"]).optional(),
    include_domains: z.array(domain).max(100).optional(),
    exclude_domains: z.array(domain).max(100).optional(),
    include_answer: z.boolean().default(false),
  })
  .strict();

const publicUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    // Tavily performs the fetch, but avoid accidentally forwarding local URLs or credentials.
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.port &&
      domain.safeParse(host).success &&
      !["localhost", "local", "internal", "test", "invalid"].some(
        (suffix) => host === suffix || host.endsWith(`.${suffix}`),
      )
    );
  }, "Use a public HTTP(S) URL without credentials, an IP address, or a custom port.");

export const extractSchema = z
  .object({
    urls: z.array(publicUrl).min(1).max(5),
    extract_depth: z.enum(["basic", "advanced"]).default("basic"),
    format: z.enum(["markdown", "text"]).default("markdown"),
  })
  .strict();

export const resetSchema = z
  .object({ key_id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/) })
  .strict();
