import { describe, expect, it } from 'vitest';
import { ApiError, isAbortError, NETWORK_ERROR_MESSAGE } from './errors';

describe('ApiError', () => {
  it('keeps the name, status, and message', () => {
    const error = new ApiError('Not found', 404);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ApiError');
    expect(error.status).toBe(404);
    expect(error.message).toBe('Not found');
  });

  it('exposes the network error message', () => {
    expect(NETWORK_ERROR_MESSAGE).toBe('The API is not reachable');
  });
});

describe('isAbortError', () => {
  it('is true for an AbortError', () => {
    expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true);
  });

  it('is false for other errors and values', () => {
    expect(isAbortError(new TypeError('failed to fetch'))).toBe(false);
    expect(isAbortError(new ApiError('x', 500))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
  });
});
