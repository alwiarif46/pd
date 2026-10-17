/**
 * Email (Resend) and SMS (Telnyx) delivery for the out-of-band secrets: sign-up email links,
 * phone codes, reset links and invites. Plain `fetch`, no SDKs: each provider is one POST.
 *
 * Rules for everything here:
 * - Nothing in this file logs. Errors are DeliveryErrors whose messages name the provider and
 *   the HTTP status only: never the destination, the secret, the link, an API key, or the
 *   provider's response body (which can echo the destination).
 * - Every request has a timeout, and any non-2xx answer throws. sendOutOfBand (security.ts)
 *   catches and logs it, and the route still answers as it would on success; the user can
 *   ask for a resend.
 */
import { DeliveryError, deliverWithoutSender, type OutOfBandMessage, type OutOfBandSink, setOutOfBandSink } from './security.js';

const RESEND_URL = 'https://api.resend.com/emails';
const TELNYX_URL = 'https://api.telnyx.com/v2/messages';
const DEFAULT_TIMEOUT_MS = 10_000;
const USER_AGENT = 'shaavir-pd-api';
const PRODUCT = 'Shaavir PD';

export interface EmailConfig {
  /** RESEND_API_KEY. */
  apiKey: string;
  /** PD_EMAIL_FROM: `Name <address>` or a bare address, on a domain verified in Resend. */
  from: string;
  /** APP_URL: the web app's public origin (and optional base path), no trailing slash. */
  appUrl: string;
}

export interface SmsConfig {
  /** TELNYX_API_KEY. */
  apiKey: string;
  /** TELNYX_FROM: an E.164 number on the Telnyx account. */
  from?: string;
  /** TELNYX_MESSAGING_PROFILE_ID. Sent whenever it is set; preferred over `from`. */
  messagingProfileId?: string;
}

export interface DeliveryConfig {
  email: EmailConfig | null;
  sms: SmsConfig | null;
}

export interface SenderOptions {
  /** Test seam; defaults to the global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

type Sender = (message: OutOfBandMessage) => Promise<void>;

/** POSTs JSON with a bearer key and a timeout; throws a DeliveryError unless the answer is 2xx. */
async function postJson(provider: string, url: string, apiKey: string, body: unknown, options: SenderOptions): Promise<void> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify(body),
      // Never follow a redirect with the key attached.
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : 'error';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new DeliveryError(`${provider} did not answer within ${timeoutMs} ms`);
    }
    // A network error's message can include request details; only its name is kept.
    throw new DeliveryError(`${provider} request failed (${name})`);
  }
  // The body is never read into an error or a log: it can echo the destination.
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) {
    throw new DeliveryError(`${provider} answered HTTP ${response.status}`);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

interface EmailContent {
  subject: string;
  intro: string;
  action: string;
  expiry: string;
  path: string;
}

/** The web routes these links open (apps/web/src/features/auth/routes.ts and shell/routes.ts). */
const EMAILS: Record<'verify_email' | 'reset_password' | 'invite', EmailContent> = {
  verify_email: {
    subject: `Confirm your email for ${PRODUCT}`,
    intro: `Confirm your email address to finish signing up for ${PRODUCT}.`,
    action: 'Confirm email',
    expiry: 'The link works for 24 hours. If you did not sign up, ignore this email.',
    path: '#/verify',
  },
  reset_password: {
    subject: `Reset your ${PRODUCT} password`,
    intro: `Someone asked to reset the password for your ${PRODUCT} account.`,
    action: 'Choose a new password',
    expiry: 'The link works for 1 hour and only once. If you did not ask for this, ignore this email; your password has not changed.',
    path: '#/reset',
  },
  invite: {
    subject: `You are invited to join a team on ${PRODUCT}`,
    intro: `You have been invited to join an organization on ${PRODUCT}.`,
    action: 'Accept the invite',
    expiry: 'The invite works for 7 days. If you were not expecting it, ignore this email.',
    path: '#/invite',
  },
};

export function emailLink(appUrl: string, path: string, secret: string): string {
  return `${appUrl.replace(/\/+$/, '')}/${path}?token=${encodeURIComponent(secret)}`;
}

export function resendEmailSender(config: EmailConfig, options: SenderOptions = {}): Sender {
  return async (message) => {
    if (message.channel !== 'email' || message.purpose === 'verify_phone') {
      throw new DeliveryError(`resend cannot send ${message.purpose}`);
    }
    const content = EMAILS[message.purpose];
    const link = emailLink(config.appUrl, content.path, message.secret);
    const text = `${content.intro}\n\n${content.action}:\n${link}\n\n${content.expiry}\n`;
    const html = [
      '<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111">',
      `<p>${escapeHtml(content.intro)}</p>`,
      `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;text-decoration:none;border-radius:6px">${escapeHtml(content.action)}</a></p>`,
      `<p style="font-size:13px;color:#555">Or paste this link into your browser:<br>${escapeHtml(link)}</p>`,
      `<p style="font-size:13px;color:#555">${escapeHtml(content.expiry)}</p>`,
      '</body></html>',
    ].join('');
    await postJson('resend', RESEND_URL, config.apiKey, {
      from: config.from,
      to: [message.to],
      subject: content.subject,
      text,
      html,
    }, options);
  };
}

export function telnyxSmsSender(config: SmsConfig, options: SenderOptions = {}): Sender {
  return async (message) => {
    if (message.channel !== 'sms' || message.purpose !== 'verify_phone') {
      throw new DeliveryError(`telnyx cannot send ${message.purpose}`);
    }
    await postJson('telnyx', TELNYX_URL, config.apiKey, {
      ...(config.messagingProfileId ? { messaging_profile_id: config.messagingProfileId } : {}),
      ...(config.from ? { from: config.from } : {}),
      to: message.to,
      text: `${PRODUCT} code: ${message.secret}. It expires in 10 minutes. Do not share it.`,
    }, options);
  };
}

/**
 * Routes each message to the sender for its channel. A channel with no sender goes to
 * deliverWithoutSender: the dev print in local development, otherwise a warning and no send.
 */
export function createOutOfBandSink(config: DeliveryConfig, options: SenderOptions = {}): OutOfBandSink {
  const email = config.email ? resendEmailSender(config.email, options) : null;
  const sms = config.sms ? telnyxSmsSender(config.sms, options) : null;
  return async (message) => {
    const sender = message.channel === 'email' ? email : sms;
    if (!sender) {
      deliverWithoutSender(message);
      return;
    }
    await sender(message);
  };
}

type Env = Record<string, string | undefined>;

function read(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

const ADDRESS = '[^\\s<>@",;()]+@[^\\s<>@",;()]+\\.[A-Za-z]{2,}';
const FROM_BARE = new RegExp(`^${ADDRESS}$`);
const FROM_NAMED = new RegExp(`^[^<>"\\r\\n]+ <${ADDRESS}>$`);
const TOKEN_LIKE = /^\S+$/;
const E164 = /^\+[1-9]\d{6,14}$/;
const PROFILE_ID = /^[A-Za-z0-9-]+$/;

function appUrlProblem(value: string, production: boolean): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'APP_URL is not a URL (for example https://pd.shaavir.com)';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'APP_URL must be an http or https URL';
  }
  if (production && url.protocol !== 'https:') {
    return 'APP_URL must be https with NODE_ENV=production';
  }
  if (url.search || url.hash || url.username || url.password) {
    return 'APP_URL must be an origin (and optional path) with no query, fragment or credentials';
  }
  return null;
}

/**
 * Reads the email and SMS settings. A channel is on when its settings are set and valid, and off
 * when none of them are set. Throws, in any environment, on half a channel or an invalid value;
 * with NODE_ENV=production, also when either channel is off, because sign-up, reset and invites
 * need email and sign-up needs SMS. Error messages name settings, never their values.
 */
export function deliveryConfigFromEnv(env: Env = process.env): DeliveryConfig {
  const production = env.NODE_ENV === 'production';
  const problems: string[] = [];

  const resendKey = read(env, 'RESEND_API_KEY');
  const emailFrom = read(env, 'PD_EMAIL_FROM');
  const appUrl = read(env, 'APP_URL');
  let email: EmailConfig | null = null;
  if (resendKey || emailFrom || production) {
    if (!resendKey) problems.push('RESEND_API_KEY is not set');
    else if (!TOKEN_LIKE.test(resendKey)) problems.push('RESEND_API_KEY is not valid (it contains whitespace)');
    if (!emailFrom) problems.push('PD_EMAIL_FROM is not set (for example "Shaavir PD <no-reply@notify.shaavir.com>")');
    else if (/[\r\n]/.test(emailFrom) || !(FROM_BARE.test(emailFrom) || FROM_NAMED.test(emailFrom))) {
      problems.push('PD_EMAIL_FROM must be "Name <address>" or a bare address');
    }
    const urlProblem = appUrl ? appUrlProblem(appUrl, production) : 'APP_URL is not set (the email links point at it)';
    if (urlProblem) problems.push(urlProblem);
    if (resendKey && emailFrom && appUrl) {
      email = { apiKey: resendKey, from: emailFrom, appUrl: appUrl.replace(/\/+$/, '') };
    }
  }

  const telnyxKey = read(env, 'TELNYX_API_KEY');
  const telnyxFrom = read(env, 'TELNYX_FROM');
  const profileId = read(env, 'TELNYX_MESSAGING_PROFILE_ID');
  let sms: SmsConfig | null = null;
  if (telnyxKey || telnyxFrom || profileId || production) {
    if (!telnyxKey) problems.push('TELNYX_API_KEY is not set');
    else if (!TOKEN_LIKE.test(telnyxKey)) problems.push('TELNYX_API_KEY is not valid (it contains whitespace)');
    if (!telnyxFrom && !profileId) problems.push('TELNYX_FROM or TELNYX_MESSAGING_PROFILE_ID must be set');
    if (telnyxFrom && !E164.test(telnyxFrom)) problems.push('TELNYX_FROM must be an E.164 number such as +15551234567');
    if (profileId && !PROFILE_ID.test(profileId)) problems.push('TELNYX_MESSAGING_PROFILE_ID is not valid');
    if (telnyxKey && (telnyxFrom || profileId)) {
      sms = {
        apiKey: telnyxKey,
        ...(telnyxFrom ? { from: telnyxFrom } : {}),
        ...(profileId ? { messagingProfileId: profileId } : {}),
      };
    }
  }

  if (problems.length > 0) {
    throw new Error(`Email/SMS delivery settings: ${problems.join('; ')}.${production ? ' Refusing to start with NODE_ENV=production.' : ''}`);
  }
  return { email, sms };
}

/**
 * Startup: reads the settings and, when either channel is on, installs the sink that sends
 * through Resend and Telnyx. With neither on (local development), installs nothing, so the dev
 * print (NODE_ENV=development + PD_DEV_PRINT_SECRETS=1) keeps working. Throws as
 * deliveryConfigFromEnv does.
 */
export function installDeliveryFromEnv(env: Env = process.env, options: SenderOptions = {}): { email: boolean; sms: boolean } {
  const config = deliveryConfigFromEnv(env);
  if (config.email || config.sms) {
    setOutOfBandSink(createOutOfBandSink(config, options));
  }
  return { email: Boolean(config.email), sms: Boolean(config.sms) };
}
