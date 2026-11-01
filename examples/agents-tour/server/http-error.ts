/**
 * @module
 * Thrown by a route to answer with a status other than 200; `body` is sent
 * as the JSON answer.
 */
export class HttpError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    super(typeof body === "string" ? body : JSON.stringify(body));
    this.status = status;
    this.body = body;
  }
}
