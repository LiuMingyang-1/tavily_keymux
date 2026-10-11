import { ServiceError } from "../errors.js";
import type { JsonObject, SearchProvider, TavilyOperation } from "../types.js";
import type { ExecutionResult } from "../key-pool/object.js";

export interface PoolService {
  execute(
    operation: TavilyOperation,
    input: JsonObject,
  ): Promise<ExecutionResult>;
  status(): Promise<unknown>;
  reset(id: string): Promise<boolean>;
}

export class TavilyProvider implements SearchProvider {
  readonly name = "tavily";

  constructor(private readonly pool: PoolService) {}

  private async call(
    operation: TavilyOperation,
    input: JsonObject,
  ): Promise<JsonObject> {
    const result = await this.pool.execute(operation, input);
    if (!result.ok)
      throw new ServiceError(
        result.code,
        result.message,
        502,
        result.retryAfterSeconds,
      );
    return result.data;
  }

  search(input: JsonObject) {
    return this.call("search", input);
  }
  extract(input: JsonObject) {
    return this.call("extract", input);
  }
}
