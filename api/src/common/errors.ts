import { HttpException, HttpStatus } from '@nestjs/common';

/** Every API error carries a machine-readable `code` next to the human `message`. */
function err(status: HttpStatus, code: string, message: string, extra?: Record<string, unknown>) {
  return new HttpException({ statusCode: status, code, message, ...extra }, status);
}

export const badRequest = (code: string, message: string, extra?: Record<string, unknown>) =>
  err(HttpStatus.BAD_REQUEST, code, message, extra);
export const unauthorized = (code: string, message: string) => err(HttpStatus.UNAUTHORIZED, code, message);
export const forbidden = (code: string, message: string) => err(HttpStatus.FORBIDDEN, code, message);
export const notFound = (code: string, message: string) => err(HttpStatus.NOT_FOUND, code, message);
export const conflict = (code: string, message: string, extra?: Record<string, unknown>) =>
  err(HttpStatus.CONFLICT, code, message, extra);
