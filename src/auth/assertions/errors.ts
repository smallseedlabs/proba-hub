export type TokenVerificationCode = 'invalid_token' | 'token_expired';

/** Thrown when a service token or act-as assertion fails verification. */
export class TokenVerificationError extends Error {
  constructor(
    readonly code: TokenVerificationCode,
    message: string
  ) {
    super(message);
    this.name = 'TokenVerificationError';
  }
}
