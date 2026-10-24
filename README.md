# IRA

**IRA**, a simple and fast hospital appointment booking system with three roles. It
comes with an MCP server, so Claude can operate it (including by voice) as a patient or as a
hospital/doctor.

| Role | What they can do |
|---|---|
| **Admin** | Platform overview (hospitals, doctors, patients, appointments), add or delete hospitals (each gets a login), every hospital's doctors and patients, and all patients with the hospitals they visit |
| **Hospital** | **Doctors**: add, edit and remove doctors (name, specialty, qualification, experience, fee, contact, bio, weekly days, hours, appointment length, days off, availability switch). Plus a month calendar filterable by doctor, marking visits completed or cancelled, its patients and the doctors they've seen, and hospital details |
| **Patient** | Browse and search hospitals and doctors (by name or specialty), pick a doctor, see that doctor's live free slots, book, reschedule, cancel, add visits to a calendar, see history |

Every appointment is with a specific doctor. Slots come from that doctor's own timings, days off
and availability, and double-booking is prevented per doctor.

## Architecture

```
Browser ──► Vercel CDN: public/ (vanilla-JS SPA, optimistic UI)
        └─► api/index.js  (Node)   ──► Supabase Postgres (schema "careslot")
               /api/*     REST API
               /oauth/*   OAuth 2.1 login for the Claude connector
Claude ───► api/mcp.py    (Python) ──► IRA REST API (with the user's OAuth token)
               /mcp       MCP server (Streamable HTTP)
```

- **Optimistic UI.** Every action updates the screen instantly, then syncs; failed requests roll back.
  Every page renders from a cache and refreshes in the background.
- **Slow work runs in the background.** Handlers just write the row and queue a job in Postgres.
  The queue is drained *after* the response is sent, using Vercel's `waitUntil`. Jobs cover
  notifications, emails (simulated, stored in `careslot.emails`) and admin stats. A daily cron
  (`/api/cron`) handles cleanup.
- **No double-booking.** A partial unique index allows one active booking per doctor slot.
- **Private data.** The tables live in a `careslot` schema that Supabase's public Data API does not
  expose. The app connects as its own `careslot_app` role through the Supabase session pooler.

## Connect Claude (custom connector)

In Claude: **Settings → Connectors → Add custom connector**

- **Name:** IRA
- **MCP server URL:** `https://<your-vercel-domain>/mcp`

Claude opens IRA's login page. Choose **Patient** or **Hospital / Doctor** and log in.
Claude then gets only that role's tools. When a hospital asks for a day's appointments, Claude
first lists the doctors and asks whose schedule to show. To switch roles, disconnect and reconnect
(or add a second connector). See [`mcp/README.md`](mcp/README.md) for the full tool list.

## Run locally

Requires Node 22.13+, and [uv](https://docs.astral.sh/uv/) for the MCP server.

```bash
cp .env.example .env          # fill in DATABASE_URL (Supabase pooler, careslot_app role)
npm install
npm start                     # http://localhost:3000
cd mcp && uv run ira-mcp # MCP at http://localhost:8765/mcp (OAuth via localhost:3000)
cd mcp && uv run python tests/e2e.py   # end-to-end MCP + OAuth test
```

## Deploy (Vercel)

The project root deploys as-is. `vercel.json` routes `/mcp` to the Python function and
everything else under `/api`, `/oauth` and OAuth discovery to the Node function. Set these
environment variables:

| Variable | Example |
|---|---|
| `DATABASE_URL` | `postgresql://careslot_app.<ref>:<password>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres` |
| `PUBLIC_URL` | `https://<your-vercel-domain>` (OAuth issuer) |
| `IRA_URL` | same as `PUBLIC_URL` (used by the MCP function) |
| `MCP_PUBLIC_URL` | `https://<your-vercel-domain>/mcp` |
| `CRON_SECRET` | any random string (protects `/api/cron`) |
| `APP_TIMEZONE` | optional, default `Asia/Kolkata` (servers run in UTC; slots are local time) |

## Project layout

```
api/index.js          Vercel Node function → server/app.js
api/mcp.py            Vercel Python function → mcp/src/ira_mcp
server/
  app.js              request router (API + OAuth), shared by local server and Vercel
  api.js              REST routes, auth, validation (Postgres)
  oauth.js            OAuth 2.1 authorization server + login page for Claude
  jobs.js             Postgres job queue, drained after responses (waitUntil)
  stats.js, slots.js, auth.js, db.js, http.js
  index.js            local dev server (static files + the same handler)
public/               the web app (index.html, styles.css, app.js)
mcp/                  Python MCP server (uv project) + e2e test
scripts/migrate-sqlite.js   one-time import from the old local SQLite database
```
