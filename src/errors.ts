export class ServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 502,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export function publicError(error: unknown): ServiceError {
  return error instanceof ServiceError
    ? error
    : new ServiceError(
        "INTERNAL_ERROR",
        "The request could not be completed.",
        500,
      );
}
