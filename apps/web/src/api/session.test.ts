import { describe, expect, it, vi } from 'vitest';
import { getToken, notifyUnauthorized, onUnauthorized, setToken, TOKEN_KEY } from './session';

describe('token store', () => {
  it('uses the pd-token key', () => {
    expect(TOKEN_KEY).toBe('pd-token');
  });

  it('sets, gets, and clears the token', () => {
    expect(getToken()).toBeNull();
    setToken('abc');
    expect(getToken()).toBe('abc');
    expect(sessionStorage.getItem('pd-token')).toBe('abc');
    setToken(null);
    expect(getToken()).toBeNull();
    setToken('abc');
    setToken('');
    expect(sessionStorage.getItem('pd-token')).toBeNull();
  });
});

describe('onUnauthorized', () => {
  it('calls subscribed listeners until they unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = onUnauthorized(listener);
    notifyUnauthorized();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    notifyUnauthorized();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
