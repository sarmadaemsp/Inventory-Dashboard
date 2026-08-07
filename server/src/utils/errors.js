export class AppError extends Error {
  constructor(statusCode, message, code = null) {
    super(message);
    this.name       = 'AppError';
    this.statusCode = statusCode;
    this.code       = code;
  }
}
