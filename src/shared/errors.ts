/** An error whose message is safe to show to the owner. */
export class AppError extends Error {
  constructor(
    public readonly code: 'CONFIG' | 'INVALID' | 'NOT_FOUND' | 'DENIED' | 'PROVIDER' | 'INTERNAL',
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
