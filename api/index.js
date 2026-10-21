// Vercel serverless entry: every /api/*, /oauth/* and OAuth discovery request lands here
// (see the rewrites in vercel.json). Static files in /public are served by Vercel's CDN.
import '../server/tz.js';
import { handle, notFoundJson } from '../server/app.js';

export default async function handler(req, res) {
  if ((await handle(req, res)) === false) notFoundJson(res);
}
