export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, details);
export const unauthorized = (message = "Authentication required") => new HttpError(401, message);
export const forbidden = (message = "You do not have access to this resource") => new HttpError(403, message);
export const notFound = (what = "Resource") => new HttpError(404, `${what} not found`);
export const conflict = (message: string) => new HttpError(409, message);
