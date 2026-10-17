# Chat 2: identity design (architect pass, 17 Oct 2026)

Source: architect agent, read from the pinned Zitadel v4.19.5 protos. Items marked "verify in CI" come from memory and need the CI Zitadel.

## Contract additions (fold into PR 1 or a small contract PR before 3e; identity 0.3.0)
- `POST /internal/zitadel/events` (Zitadel Actions v2 webhook, signature header, private network).
- `POST /members/{userId}/owner` (transfer ownership, owner only, 404 for a foreign id). Emits `identity.role.changed`.
- `TokenClaims.zitadelUserId` optional (users with no tenant yet).
- Role on the wire stays `owner|member` (PD parity); the UI says "Admin".
- No `sso_connections` routes in chat 2.

## Migration 0002 tables (all ENABLE and FORCE RLS, no cross-schema reference, no citext)
- `tenants` (id = tenant_id = Zitadel org id, name, email_domain, slug, plan mirror, plan_status, cycle dates, status, zitadel_org_id, drive_folder_id, inbound_address, disclosures fields). Policy on `id`.
- `users` (id, tenant_id NULL until a tenant exists, zitadel_user_id unique, email with unique lower(email), email_verified, name, status, tokens_not_before, zitadel_sequence, last_seen_at). Policies: `tenant_isolation` and `self_access` on `app.zitadel_sub`.
- `memberships` (UNIQUE(user_id), partial unique owner per tenant), `invites` (token_hash only), `sso_connections`, `org_map` (check org_id = tenant_id).
- Lookup before a tenant is known: no SECURITY DEFINER function. One extra `self_access` policy on `users` keyed on `app.zitadel_sub`; helpers `withSubject` and `withTenantAndSubject` in `services/identity/src/db.ts`. Needs a written exception line in CLAUDE.md rule 4, in its own commit. Undo: DROP POLICY.

## Zitadel client
- Machine user `identity-sa`, JWT profile. `IDENTITY_ZITADEL_SERVICE_KEY` is inline JSON or a file path. Cache the token until 60 s before expiry.
- Calls: `POST /v2/organizations` with `organization_id` = tenant uuid; deactivate and reactivate user; `GET /v2/users/{id}`.
- Idempotent bootstrap script: OIDC project and app (code flow, PKCE, no secret), login policy (force MFA, passkeys on, SMS off), Google and Azure IdPs only when `IDENTITY_GOOGLE_*` or `IDENTITY_MICROSOFT_*` are set, Actions v2 target for user events.
- Mock must add: `end_session_endpoint`, fixed org claim option, `amr`, unverified email and free-mail users, `prompt=none`, jwt-bearer grant, and a new `doubles/zitadel.ts` fake of the admin API plus `signZitadelEvent()`.
- Only CI Zitadel verifies: JWT profile and rights, custom org id, hosted login PKCE and claim names, force MFA, webhook delivery, passkeys (virtual authenticator). Real Google and Microsoft SSO stay "unverified: waits on owner OAuth apps".

## Tokens
- Identity signs RS256 JWTs: iss, aud=e2e, sub (users.id), zid, tid (null before tenant), role, seat_locked, iat, exp, jti. TTL 15 min (`IDENTITY_TOKEN_TTL_SECONDS`).
- Keys: `IDENTITY_TOKEN_SIGNING_KEYS` JSON array of private JWKs, first signs, all verify. Ephemeral key outside production; refuse to start in production without keys. JWKS `max-age=300`.
- `/tokens/verify`: signature, iss, aud, exp (30 s leeway), then the database (user active, `iat >= tokens_not_before`, membership present). Service auth for chat 2: bearer `IDENTITY_SERVICE_TOKEN`, sha256 constant-time compare.
- Gateway verifies locally with jose `createRemoteJWKSet(GATEWAY_JWKS_URL)`. `tid=null` gives 403 `no_tenant`; seat locked gives 403 `seat_locked`. Denylist from `identity.user.removed`.

## Sign-in flow
`GET /auth/login` (S256 PKCE, state and nonce in a signed 10-minute cookie, relative returnTo only) to Zitadel hosted login (registration, forced MFA, Google, Microsoft), then `GET /auth/callback` (state check, code exchange, id_token check, upsert mirror via `withSubject`, issue `e2e_session` cookie, 302). No tenant: web offers "create firm" or "enter invite". `POST /tenants` refuses free email domains (400 `work_email_required`) and unverified email (403), creates the Zitadel org (id = tenant uuid), writes tenant, owner membership, org_map and outbox event in one transaction. Logout sets `tokens_not_before` and returns the Zitadel end-session URL.

## Invites
Code `<tenantId>.<64 hex>`, sha256 stored, 7 days, holds a seat. Accept reads without a lock first (guessed code gives 404 `invite_invalid`), then locks tenant and invite, checks email match on the verified mirror email, used, expired, already in org, seats.

## PR split (all fable-reviewer)
- 3a-t `e2e/c2-03at-oidc-doubles` (packages/testing only): mock OIDC additions, `doubles/zitadel.ts`.
- 3a `e2e/c2-03a-identity-schema`: migration 0002, `db.ts`, RLS matrix tests; CLAUDE.md exception in its own commit.
- 3b `e2e/c2-03b-identity-tokens`: config, keys, signer, JWKS, `/tokens/verify`, `/me`.
- 3c `e2e/c2-03c-identity-tenants`: Zitadel client, tenants, members, seats, outbox, copy script.
- 3d `e2e/c2-03d-identity-invites`: invites, work-email list, delivery sink, transfer owner, events.
- 3e `e2e/c2-03e-identity-oidc`: `/auth/*`, state cookie, Zitadel events webhook, bootstrap.
- 3f `e2e/c2-03f-identity-stack`: compose service, one-shot bootstrap, `stack-smoke.py identity`, CI env.
- 4a `e2e/c2-04a-token-verifier` (service-kit): `verifyRequestToken` with JWKS cache.
- Then gateway (PR 4) and sign-in cleanup (PR 5).

## Owner questions (safest default chosen)
1. Users live in Zitadel's default org plus a per-tenant org (id = tenant_id). 2. Zitadel MFA always asked, even for Google or Microsoft sign-in. 3. 15-minute token with silent re-login; no refresh endpoint yet. 4. Logout signs out everywhere. 5. PD users link at first login on a verified email match only. 6. Free-domain refusal at `POST /tenants` and `POST /invites`; deactivate such accounts after 7 days (proposed). 7. Public OIDC client, PKCE only. 8. One owner per tenant. 9. `identity.tenant.suspended` consumer deferred (no `billing.subscription.changed` yet).
