# IRA MCP server (Python)

Lets Claude operate IRA, **logged in as a hospital (doctor) or as a patient**, through the
[Model Context Protocol](https://modelcontextprotocol.io). Every tool replies in short,
speakable sentences, so it suits voice use (speech-to-text → Claude → text-to-speech).

The server is a thin layer over the IRA REST API. Booking rules, double-booking
protection, notifications and emails all still run in the main app, so anything done by voice
shows up instantly on the website, and the reverse.

## How login works (OAuth)

The server is an OAuth-protected MCP endpoint, and **login comes first**. When you add it as a
custom connector, Claude gets a `401` that points to IRA's login page. There you choose
**Patient** or **Hospital / Doctor** and log in, and the password never passes through the chat.
Claude then receives a token for that account, and every MCP request carries it. So the server
always knows who is calling, even on stateless serverless hosting.

Claude sees **only the tools for that account's role**:

| Logged in as | Tools |
|---|---|
| **Patient** | `list_hospitals`, `get_hospital` (incl. its doctors), `list_doctors`, `find_doctors` (by name or specialty, across hospitals), `check_availability`, `find_next_available`, `book_appointment` (with a doctor), `my_appointments`, `reschedule_appointment`, `cancel_appointment` |
| **Hospital** | `hospital_summary` (today per doctor), `my_doctors`, `add_doctor`, `update_doctor` (details, timings, availability, days off), `remove_doctor`, `get_schedule` (any date, per doctor), `get_appointments` (date range, per doctor), `complete_appointment`, `cancel_appointment`, `list_patients`, `patient_history` |
| Both | `whoami`, `notifications`, `update_my_profile` |

**Doctors come first.** If a hospital has several doctors and the user didn't say which,
`get_schedule` / `get_appointments` reply with every doctor and their appointment count for that
day. Claude then asks *"Which doctor's schedule would you like?"*, and calls again with
`doctor="Dr. Desai"` (or `doctor="all"`). The same happens for patients: `check_availability` and
`find_next_available` list each doctor's free slots first. Doctors can be named loosely: "Dr.
Desai", "Anjali", "the cardiologist", "heart doctor", "skin specialist", "dentist".

The gate is enforced in the server: a tool outside your role is refused even if it's called by
name. Logging in with the "wrong" role (a hospital email under Patient) is refused on the login
page, and admin accounts are refused. To switch accounts, disconnect and reconnect the connector,
or add two connectors and log in to each as a different account.

Dates and times can be spoken naturally: `today`, `tomorrow`, `day after tomorrow`, `Friday`,
`next Monday`, `in 3 days`, `23 Oct`, `5/11` (day/month), `2026-12-01`; `9`, `9:30 am`, `3:30`
(read as 3:30 PM), `14:00`, `noon`. Hospitals can be named loosely ("City General", "lotus").
Cancel is marked destructive, so Claude asks for confirmation first.

## Run locally

```bash
uv run ira-mcp                 # http://127.0.0.1:8765/mcp, OAuth via IRA_URL (default http://localhost:3000)
uv run python tests/e2e.py          # acts like Claude: 401 → OAuth login → tools, for both roles
```

| Variable | Default | Meaning |
|---|---|---|
| `IRA_URL` | `http://localhost:3000` | The IRA site: REST API and OAuth issuer |
| `MCP_PUBLIC_URL` | `http://localhost:8765/mcp` | Public URL of this endpoint (the OAuth resource) |
| `IRA_MCP_LOG_LEVEL` | `WARNING` | Server log level |

In production it runs as the Vercel Python function `api/mcp.py`, served at `https://<domain>/mcp`.

## Files

```
src/ira_mcp/
  __init__.py   local HTTP server (uvicorn)
  server.py     OAuth token verifier, role gate, tools, serverless ASGI app
  api.py        async IRA API client
  dates.py      natural-language date & time parsing
tests/e2e.py    end-to-end OAuth + MCP test
```
