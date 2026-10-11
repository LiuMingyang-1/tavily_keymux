import { ServiceError } from "./errors.js";

const MAX_REQUEST_BYTES = 32 * 1024;

export async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers
    .get("Content-Type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new ServiceError(
      "UNSUPPORTED_MEDIA_TYPE",
      "Use Content-Type: application/json.",
      415,
    );
  }
  if (Number(request.headers.get("Content-Length")) > MAX_REQUEST_BYTES) {
    throw new ServiceError(
      "REQUEST_TOO_LARGE",
      "Request body exceeds 32 KiB.",
      413,
    );
  }
  const reader = request.body?.getReader();
  if (!reader)
    throw new ServiceError(
      "INVALID_JSON",
      "A JSON request body is required.",
      400,
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new ServiceError(
          "REQUEST_TOO_LARGE",
          "Request body exceeds 32 KiB.",
          413,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ServiceError(
      "INVALID_JSON",
      "Request body must be valid JSON.",
      400,
    );
  }
}

export function json(
  value: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}
