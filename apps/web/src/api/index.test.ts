import { describe, expect, it } from 'vitest';
import * as api from '@/api';
import { ApiError as LegacyApiError, token as legacyToken } from '../legacy-api';

describe('@/api barrel', () => {
  it('resolves to the src/api folder and exports the client', () => {
    expect(typeof api.request).toBe('function');
    expect(typeof api.getBid).toBe('function');
    expect(typeof api.logIn).toBe('function');
    expect(typeof api.uploadFile).toBe('function');
    expect(typeof api.updateComplianceRow).toBe('function');
    expect(typeof api.onUnauthorized).toBe('function');
    expect(api.TOKEN_KEY).toBe('pd-token');
    expect(api.CHUNK_BYTES).toBe(20 * 1024 * 1024);
  });

  it('shares ApiError and the token store with the legacy client', () => {
    expect(LegacyApiError).toBe(api.ApiError);
    api.setToken('shared');
    expect(legacyToken()).toBe('shared');
  });
});
