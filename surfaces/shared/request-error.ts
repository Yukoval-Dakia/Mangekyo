export class RequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string, readonly responseCode?: string) {
    super(message);
    this.status = status;
  }
}
