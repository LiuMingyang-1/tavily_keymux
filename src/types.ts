import type { TavilyKeyPool } from "./key-pool/object.js";

export interface Env {
  KEY_POOL: DurableObjectNamespace<TavilyKeyPool>;
  CLIENT_TOKENS: string;
  ADMIN_TOKEN: string;
  TAVILY_API_KEYS: string;
}

export type TavilyOperation = "search" | "extract";
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };
export type JsonObject = { [key: string]: JsonValue | undefined };

export interface SearchProvider {
  readonly name: string;
  search(input: JsonObject): Promise<JsonObject>;
  extract(input: JsonObject): Promise<JsonObject>;
}
