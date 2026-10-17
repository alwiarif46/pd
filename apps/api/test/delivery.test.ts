import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOutOfBandSink,
  deliveryConfigFromEnv,
  installDeliveryFromEnv,
  resendEmailSender,
  telnyxSmsSender,
  type EmailConfig,
  type SmsConfig,
} from '../src/delivery.js';
import { type OutOfBandMessage, sendOutOfBand, setOutOfBandSink } from '../src/security.js';

// Every test here mocks fetch. Nothing calls Resend or Telnyx, and no message is sent.

const RESEND_KEY = 're_test_key_not_real_0123456789';
const TELNYX_KEY = 'KEY_test_not_real_ABCDEF0123456789';
const TOKEN = 'a'.repeat(64);
const CODE = '424242';
const EMAIL = 'pat@acme-test.com';
const PHONE = '+15550001111';

const emailConfig: EmailConfig = {
  apiKey: RESEND_KEY,
  from: 'Shaavir PD <no-reply@notify.shaavir.com>',
  appUrl: 'https://pd.shaavir.com',
};
const smsConfig: SmsConfig = { apiKey: TELNYX_KEY, from: '+15557654321' };

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** A fetch stand-in that records each call and answers with `status`. */
function fakeFetch(status = 200, responseBody: unknown = { id: 'x' }) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({
      url: String(input),
      init,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    });
    return new Response(JSON.stringify(responseBody), { status, headers: { 'content-type': 'application/json' } });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

/** A fetch that never answers until its signal aborts. */
function hangingFetch() {
  return vi.fn((_input: string | URL | Request, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
  })) as unknown as typeof fetch;
}

function captureConsole() {
  const lines: string[] = [];
  for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => (arg instanceof Error ? `${arg.name} ${arg.message} ${arg.stack}` : String(arg))).join(' '));
    });
  }
  return lines;
}

function expectNoSecrets(output: string) {
  for (const secret of [RESEND_KEY, TELNYX_KEY, TOKEN, CODE, EMAIL, PHONE, '5550001111', 'pd.shaavir.com/#']) {
    expect(output).not.toContain(secret);
  }
}

const verifyEmail: OutOfBandMessage = { channel: 'email', purpose: 'verify_email', to: EMAIL, secret: TOKEN };
const resetPassword: OutOfBandMessage = { channel: 'email', purpose: 'reset_password', to: EMAIL, secret: TOKEN };
const invite: OutOfBandMessage = { channel: 'email', purpose: 'invite', to: EMAIL, secret: `11111111-2222-3333-4444-555555555555.${TOKEN}` };
const phoneCode: OutOfBandMessage = { channel: 'sms', purpose: 'verify_phone', to: PHONE, secret: CODE };

afterEach(() => {
  setOutOfBandSink(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Resend email sender', () => {
  it('posts to the Resend API with a bearer key, JSON, and one recipient', async () => {
    const { fetch, calls } = fakeFetch();
    await resendEmailSender(emailConfig, { fetch })(verifyEmail);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe('https://api.resend.com/emails');
    expect(call.init.method).toBe('POST');
    expect(call.headers.authorization).toBe(`Bearer ${RESEND_KEY}`);
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.headers['user-agent']).toBeTruthy();
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(call.init.redirect).toBe('error');
    expect(call.body.from).toBe(emailConfig.from);
    expect(call.body.to).toEqual([EMAIL]);
    expect(typeof call.body.subject).toBe('string');
    expect(typeof call.body.text).toBe('string');
    expect(typeof call.body.html).toBe('string');
  });

  it.each([
    ['verify_email', verifyEmail, `https://pd.shaavir.com/#/verify?token=${TOKEN}`],
    ['reset_password', resetPassword, `https://pd.shaavir.com/#/reset?token=${TOKEN}`],
    ['invite', invite, `https://pd.shaavir.com/#/invite?token=11111111-2222-3333-4444-555555555555.${TOKEN}`],
  ])('links %s to the web route that handles it, in the text and the html', async (_purpose, message, link) => {
    const { fetch, calls } = fakeFetch();
    await resendEmailSender(emailConfig, { fetch })(message);
    expect(calls[0].body.text).toContain(link);
    expect(calls[0].body.html).toContain(`href="${link}"`);
  });

  it('gives each purpose its own subject', async () => {
    const { fetch, calls } = fakeFetch();
    const send = resendEmailSender(emailConfig, { fetch });
    await send(verifyEmail);
    await send(resetPassword);
    await send(invite);
    expect(new Set(calls.map((call) => call.body.subject)).size).toBe(3);
  });

  it('strips a trailing slash from APP_URL', async () => {
    const { fetch, calls } = fakeFetch();
    await resendEmailSender({ ...emailConfig, appUrl: 'https://pd.shaavir.com/' }, { fetch })(verifyEmail);
    expect(calls[0].body.text).toContain(`https://pd.shaavir.com/#/verify?token=${TOKEN}`);
  });

  it.each([400, 401, 403, 422, 429, 500, 503])('throws on a %i answer, without the secret in the error', async (status) => {
    const { fetch } = fakeFetch(status, { message: `bad ${EMAIL} ${TOKEN}` });
    const error = await resendEmailSender(emailConfig, { fetch })(verifyEmail).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    const text = `${(error as Error).name} ${(error as Error).message}`;
    expect(text).toContain(String(status));
    expectNoSecrets(text);
  });

  it('throws when the API does not answer in time', async () => {
    const send = resendEmailSender(emailConfig, { fetch: hangingFetch(), timeoutMs: 20 });
    await expect(send(verifyEmail)).rejects.toThrow();
  });

  it('refuses an SMS purpose', async () => {
    const { fetch, calls } = fakeFetch();
    await expect(resendEmailSender(emailConfig, { fetch })({ ...phoneCode, channel: 'email' })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('logs nothing itself', async () => {
    const lines = captureConsole();
    const { fetch } = fakeFetch();
    await resendEmailSender(emailConfig, { fetch })(verifyEmail);
    expect(lines).toEqual([]);
  });
});

describe('Telnyx SMS sender', () => {
  it('posts to the Telnyx API with a bearer key, from, to and a short text', async () => {
    const { fetch, calls } = fakeFetch();
    await telnyxSmsSender(smsConfig, { fetch })(phoneCode);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe('https://api.telnyx.com/v2/messages');
    expect(call.init.method).toBe('POST');
    expect(call.headers.authorization).toBe(`Bearer ${TELNYX_KEY}`);
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(call.init.redirect).toBe('error');
    expect(call.body).toEqual({ from: '+15557654321', to: PHONE, text: expect.stringContaining(CODE) });
    expect(String(call.body.text).length).toBeLessThanOrEqual(160);
  });

  it('sends with the messaging profile when only the profile is set', async () => {
    const { fetch, calls } = fakeFetch();
    await telnyxSmsSender({ apiKey: TELNYX_KEY, messagingProfileId: '40017f8e-49bd-4f16-9e3d-ef103f916228' }, { fetch })(phoneCode);
    expect(calls[0].body).toEqual({ messaging_profile_id: '40017f8e-49bd-4f16-9e3d-ef103f916228', to: PHONE, text: expect.stringContaining(CODE) });
  });

  it('sends the profile and the number when both are set', async () => {
    const { fetch, calls } = fakeFetch();
    await telnyxSmsSender({ ...smsConfig, messagingProfileId: '40017f8e-49bd-4f16-9e3d-ef103f916228' }, { fetch })(phoneCode);
    expect(calls[0].body).toMatchObject({ messaging_profile_id: '40017f8e-49bd-4f16-9e3d-ef103f916228', from: '+15557654321' });
  });

  it.each([400, 401, 403, 422, 429, 500])('throws on a %i answer, without the secret in the error', async (status) => {
    const { fetch } = fakeFetch(status, { errors: [{ detail: `${PHONE} ${CODE}` }] });
    const error = await telnyxSmsSender(smsConfig, { fetch })(phoneCode).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    const text = `${(error as Error).name} ${(error as Error).message}`;
    expect(text).toContain(String(status));
    expectNoSecrets(text);
  });

  it('throws when the API does not answer in time', async () => {
    const send = telnyxSmsSender(smsConfig, { fetch: hangingFetch(), timeoutMs: 20 });
    await expect(send(phoneCode)).rejects.toThrow();
  });

  it('refuses an email purpose', async () => {
    const { fetch, calls } = fakeFetch();
    await expect(telnyxSmsSender(smsConfig, { fetch })({ ...verifyEmail, channel: 'sms' })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('the installed sink, through sendOutOfBand', () => {
  it('routes email to Resend and SMS to Telnyx', async () => {
    const { fetch, calls } = fakeFetch();
    setOutOfBandSink(createOutOfBandSink({ email: emailConfig, sms: smsConfig }, { fetch }));
    await sendOutOfBand(verifyEmail);
    await sendOutOfBand(phoneCode);
    expect(calls.map((call) => call.url)).toEqual(['https://api.resend.com/emails', 'https://api.telnyx.com/v2/messages']);
  });

  it('logs a failure with the provider and status, and no secret, destination, key or link', async () => {
    const lines = captureConsole();
    const { fetch } = fakeFetch(422, { message: `${EMAIL} ${TOKEN} ${PHONE} ${CODE}` });
    setOutOfBandSink(createOutOfBandSink({ email: emailConfig, sms: smsConfig }, { fetch }));
    await expect(sendOutOfBand(verifyEmail)).resolves.toBeUndefined();
    await expect(sendOutOfBand(phoneCode)).resolves.toBeUndefined();
    const output = lines.join('\n');
    expect(output).toContain('resend');
    expect(output).toContain('telnyx');
    expect(output).toContain('422');
    expectNoSecrets(output);
  });

  it('logs a timeout without secrets', async () => {
    const lines = captureConsole();
    setOutOfBandSink(createOutOfBandSink({ email: emailConfig, sms: smsConfig }, { fetch: hangingFetch(), timeoutMs: 20 }));
    await expect(sendOutOfBand(verifyEmail)).resolves.toBeUndefined();
    const output = lines.join('\n');
    expect(output).toMatch(/failed/);
    expectNoSecrets(output);
  });

  it('logs a network error without secrets', async () => {
    const lines = captureConsole();
    const failing = vi.fn(async () => {
      throw new TypeError(`fetch failed for ${EMAIL} ${TOKEN}`);
    }) as unknown as typeof globalThis.fetch;
    setOutOfBandSink(createOutOfBandSink({ email: emailConfig, sms: smsConfig }, { fetch: failing }));
    await expect(sendOutOfBand(verifyEmail)).resolves.toBeUndefined();
    expectNoSecrets(lines.join('\n'));
  });

  it('falls back to the dev print for a channel that is not configured, in development only', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('PD_DEV_PRINT_SECRETS', '1');
    const lines = captureConsole();
    const { fetch, calls } = fakeFetch();
    setOutOfBandSink(createOutOfBandSink({ email: emailConfig, sms: null }, { fetch }));
    await sendOutOfBand(phoneCode);
    expect(calls).toHaveLength(0);
    expect(lines.join('\n')).toContain(CODE);
  });

  it('sends nothing and prints no secret for an unconfigured channel outside development', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('PD_DEV_PRINT_SECRETS', '1');
    const lines = captureConsole();
    const { fetch, calls } = fakeFetch();
    setOutOfBandSink(createOutOfBandSink({ email: null, sms: smsConfig }, { fetch }));
    await sendOutOfBand(verifyEmail);
    expect(calls).toHaveLength(0);
    expectNoSecrets(lines.join('\n'));
  });
});

describe('delivery settings from the environment', () => {
  const full = {
    RESEND_API_KEY: RESEND_KEY,
    PD_EMAIL_FROM: 'Shaavir PD <no-reply@notify.shaavir.com>',
    APP_URL: 'https://pd.shaavir.com',
    TELNYX_API_KEY: TELNYX_KEY,
    TELNYX_FROM: '+15557654321',
  };

  it('reads both channels', () => {
    expect(deliveryConfigFromEnv({ ...full, NODE_ENV: 'production' })).toEqual({
      email: { apiKey: RESEND_KEY, from: full.PD_EMAIL_FROM, appUrl: 'https://pd.shaavir.com' },
      sms: { apiKey: TELNYX_KEY, from: '+15557654321' },
    });
  });

  it('reads a bare from address and the messaging profile', () => {
    const config = deliveryConfigFromEnv({
      ...full,
      PD_EMAIL_FROM: 'no-reply@notify.shaavir.com',
      TELNYX_FROM: '',
      TELNYX_MESSAGING_PROFILE_ID: '40017f8e-49bd-4f16-9e3d-ef103f916228',
    });
    expect(config.email?.from).toBe('no-reply@notify.shaavir.com');
    expect(config.sms).toEqual({ apiKey: TELNYX_KEY, messagingProfileId: '40017f8e-49bd-4f16-9e3d-ef103f916228' });
  });

  it('leaves both channels off when nothing is set, outside production', () => {
    expect(deliveryConfigFromEnv({ NODE_ENV: 'development', APP_URL: 'http://localhost:3000' })).toEqual({ email: null, sms: null });
  });

  it.each([
    ['RESEND_API_KEY'],
    ['PD_EMAIL_FROM'],
    ['APP_URL'],
    ['TELNYX_API_KEY'],
    ['TELNYX_FROM'],
  ])('refuses production without %s', (name) => {
    const env: Record<string, string> = { ...full, NODE_ENV: 'production' };
    delete env[name];
    expect(() => deliveryConfigFromEnv(env)).toThrow(name === 'TELNYX_FROM' ? /TELNYX_FROM|TELNYX_MESSAGING_PROFILE_ID/ : new RegExp(name));
  });

  it('refuses production with an http APP_URL', () => {
    expect(() => deliveryConfigFromEnv({ ...full, NODE_ENV: 'production', APP_URL: 'http://pd.shaavir.com' })).toThrow(/APP_URL/);
  });

  it.each([
    [{ RESEND_API_KEY: RESEND_KEY }, /PD_EMAIL_FROM/],
    [{ PD_EMAIL_FROM: 'no-reply@notify.shaavir.com' }, /RESEND_API_KEY/],
    [{ TELNYX_API_KEY: TELNYX_KEY }, /TELNYX_FROM/],
    [{ TELNYX_FROM: '+15557654321' }, /TELNYX_API_KEY/],
  ])('refuses half a channel in any environment (%o)', (partial, message) => {
    expect(() => deliveryConfigFromEnv({ NODE_ENV: 'development', APP_URL: 'http://localhost:3000', ...partial })).toThrow(message);
  });

  it.each([
    ['PD_EMAIL_FROM', 'not an address'],
    ['PD_EMAIL_FROM', 'Shaavir PD <no-reply@notify.shaavir.com>\r\nBcc: x@y.com'],
    ['APP_URL', 'pd.shaavir.com'],
    ['APP_URL', 'https://pd.shaavir.com/?a=1'],
    ['TELNYX_FROM', '5557654321'],
    ['TELNYX_FROM', '+1 555 765 4321'],
    ['TELNYX_MESSAGING_PROFILE_ID', 'has spaces in it'],
    ['RESEND_API_KEY', 'key with spaces'],
  ])('refuses an invalid %s', (name, value) => {
    expect(() => deliveryConfigFromEnv({ ...full, NODE_ENV: 'development', [name]: value })).toThrow(new RegExp(name));
  });

  it('never puts a key in its error messages', () => {
    const errors: string[] = [];
    for (const env of [
      { RESEND_API_KEY: RESEND_KEY },
      { TELNYX_API_KEY: TELNYX_KEY },
      { ...full, RESEND_API_KEY: `${RESEND_KEY} x`, NODE_ENV: 'production' },
      { ...full, TELNYX_API_KEY: `${TELNYX_KEY} x`, NODE_ENV: 'production' },
    ]) {
      try {
        deliveryConfigFromEnv(env);
      } catch (error) {
        errors.push((error as Error).message);
      }
    }
    expect(errors).toHaveLength(4);
    expectNoSecrets(errors.join('\n'));
  });
});

describe('installDeliveryFromEnv', () => {
  it('installs a sink when a channel is configured', async () => {
    const { fetch, calls } = fakeFetch();
    const installed = installDeliveryFromEnv({
      NODE_ENV: 'development',
      RESEND_API_KEY: RESEND_KEY,
      PD_EMAIL_FROM: 'no-reply@notify.shaavir.com',
      APP_URL: 'http://localhost:3000',
    }, { fetch });
    expect(installed).toEqual({ email: true, sms: false });
    await sendOutOfBand(verifyEmail);
    expect(calls).toHaveLength(1);
  });

  it('installs nothing when no channel is configured, so the dev print keeps working', async () => {
    const before = vi.fn();
    setOutOfBandSink(before);
    expect(installDeliveryFromEnv({ NODE_ENV: 'development' })).toEqual({ email: false, sms: false });
    // An earlier sink is left alone.
    await sendOutOfBand(verifyEmail);
    expect(before).toHaveBeenCalledOnce();
  });

  it('refuses production with no channel configured, and installs nothing', () => {
    expect(() => installDeliveryFromEnv({ NODE_ENV: 'production' })).toThrow(/RESEND_API_KEY/);
  });
});
