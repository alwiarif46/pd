import { describe, expect, it } from 'vitest';
import { authHash, parseAuthHash } from './routes';

describe('parseAuthHash', () => {
  it('maps each auth path to its view', () => {
    expect(parseAuthHash('#/login').view).toBe('login');
    expect(parseAuthHash('#/signup').view).toBe('signup');
    expect(parseAuthHash('#/verify').view).toBe('verify');
    expect(parseAuthHash('#/reset').view).toBe('reset');
  });

  it('reads the token from the email link', () => {
    expect(parseAuthHash('#/verify?token=abc123')).toEqual({ view: 'verify', token: 'abc123' });
    expect(parseAuthHash('#/reset?token=a%2Bb')).toEqual({ view: 'reset', token: 'a+b' });
  });

  it('has no token when the query is empty or lacks one', () => {
    expect(parseAuthHash('#/verify').token).toBeNull();
    expect(parseAuthHash('#/verify?token=').token).toBeNull();
    expect(parseAuthHash('#/reset?other=1').token).toBeNull();
  });

  it('falls back to login', () => {
    expect(parseAuthHash('').view).toBe('login');
    expect(parseAuthHash('#/bids').view).toBe('login');
  });

  it('builds a hash without a token', () => {
    expect(authHash('verify')).toBe('#/verify');
  });
});
