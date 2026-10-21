// OAuth 2.1 authorization server for the Claude MCP connector.
//
// Claude registers itself (dynamic client registration), sends the user to /oauth/authorize,
// the user logs in as a patient or a hospital, and Claude exchanges the code (with PKCE) for
// an access token. The access token is an ordinary CareSlot session token, so the MCP server
// can verify it with GET /api/me and see exactly who the caller is.
import crypto from 'node:crypto';
import { hashToken, newToken } from './auth.js';
import { checkCredentials, createSession, SESSION_MS } from './api.js';
import { db } from './db.js';
import { esc, HttpError, readParams, redirect, sendHtml, sendJson } from './http.js';

const CODE_TTL_MS = 10 * 60_000;
const REFRESH_TTL_MS = 90 * 24 * 3600_000;
const SCOPE = 'careslot';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
};

export function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

function metadata(req) {
  const base = baseUrl(req);
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
    service_documentation: `${base}/`,
  };
}

function validRedirect(uri) {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
  } catch {
    return false;
  }
}

const tokenError = (res, error, description, status = 400) =>
  sendJson(res, status, { error, error_description: description }, CORS);

function withParams(uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);
  return u.toString();
}

async function loadClient(sql, clientId) {
  if (!clientId) return null;
  const [c] = await sql`select * from oauth_clients where client_id = ${String(clientId)}`;
  return c ?? null;
}

// ---------- endpoints ----------
async function register(req, res, sql) {
  const body = await readParams(req);
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!uris.length || uris.length > 10 || !uris.every(validRedirect)) {
    return sendJson(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https URLs (or http://localhost)' }, CORS);
  }
  if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== 'none') {
    return sendJson(res, 400, { error: 'invalid_client_metadata', error_description: 'Only public clients (token_endpoint_auth_method "none") are supported' }, CORS);
  }
  const clientId = `cs_${crypto.randomBytes(16).toString('hex')}`;
  const name = String(body.client_name || 'MCP client').slice(0, 120);
  await sql`insert into oauth_clients (client_id, client_name, redirect_uris) values (${clientId}, ${name}, ${sql.json(uris)})`;
  sendJson(res, 201, {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: SCOPE,
  }, CORS);
}

// Validates an authorization request. Returns { client, p } or sends a response itself.
async function checkAuthorizeRequest(res, sql, p) {
  const client = await loadClient(sql, p.client_id);
  const redirects = client?.redirect_uris || [];
  if (!client || !p.redirect_uri || !redirects.includes(p.redirect_uri)) {
    // Never redirect to an unverified URI: show the error here instead.
    sendHtml(res, 400, page({ title: 'Invalid sign-in link', body: `<p class="err">This sign-in link isn't valid (unknown app or redirect address). Please start the connection again from Claude.</p>` }));
    return null;
  }
  const fail = (error, description) => {
    redirect(res, withParams(p.redirect_uri, { error, error_description: description, state: p.state }));
    return null;
  };
  if (p.response_type !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported');
  if (!p.code_challenge || p.code_challenge_method !== 'S256') return fail('invalid_request', 'PKCE with S256 is required');
  return client;
}

async function authorizeGet(req, res, sql, url) {
  const p = Object.fromEntries(url.searchParams);
  const client = await checkAuthorizeRequest(res, sql, p);
  if (client) sendHtml(res, 200, loginPage(req, client, p));
}

async function authorizePost(req, res, sql) {
  const p = await readParams(req);
  const client = await checkAuthorizeRequest(res, sql, p);
  if (!client) return;
  if (p.decision === 'deny') {
    return redirect(res, withParams(p.redirect_uri, { error: 'access_denied', error_description: 'The user declined', state: p.state }));
  }
  const role = p.role === 'hospital' ? 'hospital' : 'patient';
  let user;
  try {
    user = await checkCredentials(sql, p.email, p.password);
  } catch (err) {
    if (err instanceof HttpError) return sendHtml(res, 200, loginPage(req, client, p, err.message));
    throw err;
  }
  if (user.role === 'admin') {
    return sendHtml(res, 200, loginPage(req, client, p, 'Admin accounts can only use the website. Log in as a patient or a hospital.'));
  }
  if (user.role !== role) {
    const label = user.role === 'hospital' ? 'a hospital' : 'a patient';
    return sendHtml(res, 200, loginPage(req, client, { ...p, role: user.role }, `This email belongs to ${label} account. Choose “${user.role === 'hospital' ? 'Hospital / Doctor' : 'Patient'}” above and try again.`));
  }
  const code = newToken();
  await sql`
    insert into oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at)
    values (${hashToken(code)}, ${client.client_id}, ${user.id}, ${p.redirect_uri}, ${p.code_challenge},
            ${SCOPE}, ${p.resource || null}, ${Date.now() + CODE_TTL_MS})`;
  redirect(res, withParams(p.redirect_uri, { code, state: p.state, iss: baseUrl(req) }));
}

async function issueTokens(sql, clientId, userId) {
  const session = await createSession(sql, userId);
  const refresh = newToken();
  await sql`
    insert into oauth_refresh_tokens (token_hash, client_id, user_id, scope, expires_at)
    values (${hashToken(refresh)}, ${clientId}, ${userId}, ${SCOPE}, ${Date.now() + REFRESH_TTL_MS})`;
  return {
    access_token: session.token,
    token_type: 'Bearer',
    expires_in: Math.floor(SESSION_MS / 1000),
    refresh_token: refresh,
    scope: SCOPE,
  };
}

async function token(req, res, sql) {
  const p = await readParams(req);
  if (p.grant_type === 'authorization_code') {
    if (!p.code || !p.code_verifier) return tokenError(res, 'invalid_request', 'code and code_verifier are required');
    // Single use: delete the code as we read it.
    const [row] = await sql`delete from oauth_codes where code_hash = ${hashToken(String(p.code))} returning *`;
    if (!row || row.expires_at < Date.now()) return tokenError(res, 'invalid_grant', 'The authorization code is invalid or expired');
    if (p.client_id && p.client_id !== row.client_id) return tokenError(res, 'invalid_grant', 'Code was issued to another client');
    if (p.redirect_uri && p.redirect_uri !== row.redirect_uri) return tokenError(res, 'invalid_grant', 'redirect_uri does not match');
    const challenge = crypto.createHash('sha256').update(String(p.code_verifier)).digest('base64url');
    if (challenge !== row.code_challenge) return tokenError(res, 'invalid_grant', 'PKCE verification failed');
    return sendJson(res, 200, await issueTokens(sql, row.client_id, row.user_id), CORS);
  }
  if (p.grant_type === 'refresh_token') {
    if (!p.refresh_token) return tokenError(res, 'invalid_request', 'refresh_token is required');
    // Rotate: the old refresh token stops working once used.
    const [row] = await sql`delete from oauth_refresh_tokens where token_hash = ${hashToken(String(p.refresh_token))} returning *`;
    if (!row || row.expires_at < Date.now()) return tokenError(res, 'invalid_grant', 'The refresh token is invalid or expired');
    if (p.client_id && p.client_id !== row.client_id) return tokenError(res, 'invalid_grant', 'Token was issued to another client');
    return sendJson(res, 200, await issueTokens(sql, row.client_id, row.user_id), CORS);
  }
  return tokenError(res, 'unsupported_grant_type', 'Use authorization_code or refresh_token');
}

async function revoke(req, res, sql) {
  const p = await readParams(req);
  if (p.token) {
    const h = hashToken(String(p.token));
    await sql`delete from sessions where token_hash = ${h}`;
    await sql`delete from oauth_refresh_tokens where token_hash = ${h}`;
  }
  sendJson(res, 200, {}, CORS);
}

export async function handleOAuth(req, res, url) {
  const path = url.pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  const sql = db();
  try {
    if (path.startsWith('/.well-known/oauth-authorization-server') || path === '/.well-known/openid-configuration') {
      return sendJson(res, 200, metadata(req), { ...CORS, 'Cache-Control': 'public, max-age=300' });
    }
    if (path === '/oauth/register' && req.method === 'POST') return await register(req, res, sql);
    if (path === '/oauth/authorize' && req.method === 'GET') return await authorizeGet(req, res, sql, url);
    if (path === '/oauth/authorize' && req.method === 'POST') return await authorizePost(req, res, sql);
    if (path === '/oauth/token' && req.method === 'POST') return await token(req, res, sql);
    if (path === '/oauth/revoke' && req.method === 'POST') return await revoke(req, res, sql);
    sendJson(res, 404, { error: 'not_found' }, CORS);
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: 'invalid_request', error_description: err.message }, CORS);
    console.error('[oauth]', err);
    sendJson(res, 500, { error: 'server_error' }, CORS);
  }
}

// ---------- login page ----------
const HIDDEN = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'];

function loginPage(req, client, p, error = '') {
  const role = p.role === 'hospital' ? 'hospital' : 'patient';
  const hidden = HIDDEN.filter((k) => p[k] != null).map((k) => `<input type="hidden" name="${k}" value="${esc(p[k])}">`).join('');
  const appName = esc(client.client_name || 'An app');
  return page({
    title: 'Log in to CareSlot',
    body: `
      <p class="lead"><b>${appName}</b> wants to use your CareSlot account. Choose who you are and log in. You'll only get tools for that kind of account.</p>
      ${error ? `<p class="err">${esc(error)}</p>` : ''}
      <form method="post" action="/oauth/authorize">
        ${hidden}
        <div class="roles">
          <label class="role"><input type="radio" name="role" value="patient" ${role === 'patient' ? 'checked' : ''}>
            <span><b>Patient</b><small>Book &amp; manage my appointments</small></span></label>
          <label class="role"><input type="radio" name="role" value="hospital" ${role === 'hospital' ? 'checked' : ''}>
            <span><b>Hospital / Doctor</b><small>See schedules &amp; patient records</small></span></label>
        </div>
        <label>Email<input name="email" type="email" autocomplete="email" required value="${esc(p.email || '')}"></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn" name="decision" value="allow">Log in &amp; connect</button>
        <button class="btn ghost" name="decision" value="deny" formnovalidate>Cancel</button>
      </form>
      <p class="small">New patient? <a href="${esc(baseUrl(req))}/#/register" target="_blank" rel="noopener">Create an account</a>, then come back here.</p>`,
  });
}

function page({ title, body }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>
:root{--bg:#f4f6f8;--card:#fff;--text:#141920;--muted:#5f6877;--border:#e2e6eb;--primary:#0f766e;--soft:#e0f3f0;--danger:#c2321f;--dsoft:#fdecea}
@media (prefers-color-scheme:dark){:root{--bg:#0c0f13;--card:#151a20;--text:#e9ecf1;--muted:#98a1ae;--border:#262d37;--primary:#2dd4bf;--soft:#11302d;--danger:#f87171;--dsoft:#3a1b1b}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.card{width:100%;max-width:420px;background:var(--card);border:1px solid var(--border);border-radius:18px;padding:28px;box-shadow:0 20px 40px -12px rgb(0 0 0/.25)}
.brand{display:flex;align-items:center;gap:10px;font-weight:750;font-size:19px;margin-bottom:18px}
.logo{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,#0f9488,#4f46e5);display:grid;place-items:center;color:#fff;font-weight:900}
h1{font-size:22px;margin:0 0 6px}.lead{color:var(--muted);margin:0 0 18px}.small{color:var(--muted);font-size:13px;text-align:center;margin:16px 0 0}
a{color:var(--primary)}label{display:block;font-size:13px;font-weight:600;color:var(--muted);margin-bottom:14px}
input[type=email],input[type=password]{display:block;width:100%;margin-top:6px;font:inherit;color:var(--text);background:var(--card);border:1px solid var(--border);border-radius:10px;padding:11px 12px}
input:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 4px var(--soft)}
.roles{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:18px}
.role{margin:0;cursor:pointer;border:1px solid var(--border);border-radius:12px;padding:12px;display:flex;gap:8px;align-items:flex-start;color:var(--text)}
.role:has(input:checked){border-color:var(--primary);background:var(--soft)}.role input{margin-top:3px;accent-color:var(--primary)}
.role b{display:block;font-size:14px}.role small{display:block;font-weight:500;color:var(--muted);font-size:12px}
.btn{display:block;width:100%;padding:12px;border-radius:10px;border:0;font:inherit;font-weight:650;cursor:pointer;background:linear-gradient(135deg,#0f9488,#0e7490 55%,#4f46e5);color:#fff;margin-top:4px}
.btn.ghost{background:none;color:var(--muted);border:1px solid var(--border);margin-top:8px}
.err{background:var(--dsoft);color:var(--danger);padding:10px 12px;border-radius:10px;font-size:14px}
@media (max-width:420px){.roles{grid-template-columns:1fr}}
</style></head><body><main class="card"><div class="brand"><span class="logo">+</span>CareSlot</div><h1>${esc(title)}</h1>${body}</main></body></html>`;
}

