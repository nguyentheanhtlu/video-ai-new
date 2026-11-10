/** A failed upload step; `retry` says whether the queue should try again later. */
export class UploadError extends Error {
  constructor(message: string, public retry: boolean, public waitMs?: number) {
    super(message);
  }
}
