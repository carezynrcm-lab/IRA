// One request handler for both the local dev server and Vercel serverless functions.
import { handleApi } from './api.js';
import { handleOAuth } from './oauth.js';
import { sendJson } from './http.js';

export const isOAuthPath = (p) =>
  p.startsWith('/oauth/') || p.startsWith('/.well-known/oauth-authorization-server') || p === '/.well-known/openid-configuration';

// Returns false when the path isn't an API/OAuth route (the caller serves static files).
export async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  // On Vercel, rewrites may deliver the request as /api/index?__route=<original path>.
  const route = url.searchParams.get('__route');
  if (route) {
    url.searchParams.delete('__route');
    url.pathname = route;
  }
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  if (isOAuthPath(url.pathname)) return handleOAuth(req, res, url);
  return false;
}

export function notFoundJson(res) {
  sendJson(res, 404, { error: 'Not found' });
}
