"""IRA MCP server: lets an assistant act as a patient or as a hospital.

Every tool returns short, speakable text so it works well with voice (STT → Claude → TTS).
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import time
from contextlib import contextmanager
from datetime import date, timedelta
from typing import Any, Literal
from urllib.parse import quote

from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.provider import AccessToken, TokenVerifier
from mcp.server.auth.settings import AuthSettings
from mcp.server.context import CallNext, HandlerResult, ServerMiddleware, ServerRequestContext
from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp_types import CallToolResult, TextContent, ToolAnnotations

from .api import Account, IRAClient, IRAError
from .dates import (WEEKDAYS, fmt_date, fmt_time, in_part_of_day, now_hhmm, on_date, parse_date, parse_time, today)

INSTRUCTIONS = """\
IRA is a hospital appointment booking system used by PATIENTS and HOSPITALS. Each hospital has
DOCTORS (name, specialty, timings, fee, days off, availability). Appointments are always with a
specific doctor at a hospital.

The user logged in when they connected this connector (IRA's OAuth login page, where they
chose patient or hospital), so you act as that account and see only its tools. Call `whoami` to
see who that is, plus today's date and time.
- A patient can find hospitals and doctors (by name or specialty), check a doctor's free slots,
  book, reschedule, cancel and review appointments.
- A hospital can manage its doctors (add, edit timings, days off, availability, remove), see the
  schedule for any date per doctor, appointment records, patients and their history, mark visits
  completed and cancel.
To act as a different account, the user disconnects and reconnects the connector (or adds a
second connector) and logs in as the other account.

Doctors come first:
- When a hospital has several doctors and the user hasn't said which one, tools like
  `get_schedule`, `check_availability` and `find_next_available` reply with the list of doctors
  (and a quick count for each). Then ASK THE USER which doctor they mean, and call again with
  `doctor=` set. For a hospital, `doctor="all"` shows every doctor's schedule together.
- Doctors can be named loosely: "Dr. Desai", "Anjali", or by specialty ("the cardiologist").

Working style:
- Pass dates and times exactly as the user says them ("tomorrow", "next Friday", "23 Oct",
  "3:30 pm"); the tools resolve them. Hospitals can be named loosely ("City General").
- The user may be speaking through voice. Keep replies short and natural to say out loud,
  say times like "9:30 AM", and don't read IDs aloud unless needed.
- Always confirm with the user before booking, rescheduling, cancelling, adding/removing a doctor
  or changing a doctor's timings.
"""

PartOfDay = Literal["any", "morning", "afternoon", "evening"]
DOW_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
# IRA stores working days as JS weekday numbers (0 = Sunday).
JS_TO_PY = {0: 6, 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5}
PY_TO_JS = {v: k for k, v in JS_TO_PY.items()}

READ = ToolAnnotations(read_only_hint=True, open_world_hint=False)
WRITE = ToolAnnotations(read_only_hint=False, destructive_hint=False, open_world_hint=False)
DESTRUCTIVE = ToolAnnotations(read_only_hint=False, destructive_hint=True, open_world_hint=False)

# Which tools each kind of account can see and use.
COMMON_TOOLS = {"whoami", "notifications", "update_my_profile", "cancel_appointment"}
ROLE_TOOLS = {
    "patient": COMMON_TOOLS | {
        "list_hospitals", "get_hospital", "list_doctors", "find_doctors", "check_availability",
        "find_next_available", "book_appointment", "my_appointments", "reschedule_appointment",
    },
    "hospital": COMMON_TOOLS | {
        "hospital_summary", "my_doctors", "get_schedule", "get_appointments", "complete_appointment",
        "list_patients", "patient_history", "add_doctor", "update_doctor", "remove_doctor",
    },
}

IRA_URL = os.environ.get("IRA_URL", "http://localhost:3000").rstrip("/")
# Public URL of this MCP endpoint (the OAuth "resource"), e.g. https://ira.vercel.app/mcp.
MCP_PUBLIC_URL = os.environ.get("MCP_PUBLIC_URL", "http://localhost:8765/mcp").rstrip("/")

client = IRAClient(IRA_URL)


# ---------------------------------------------------------------------------
# OAuth: every request carries an IRA access token (issued by IRA's own login page).
# ---------------------------------------------------------------------------
class IRATokenVerifier(TokenVerifier):
    """Verifies bearer tokens by asking IRA who they belong to (cached briefly)."""

    TTL = 60.0

    def __init__(self) -> None:
        self._cache: dict[str, tuple[float, AccessToken | None]] = {}

    def forget(self, token: str) -> None:
        self._cache.pop(_token_key(token), None)

    async def verify_token(self, token: str) -> AccessToken | None:
        key = _token_key(token)
        hit = self._cache.get(key)
        if hit and hit[0] > time.monotonic():
            return hit[1]
        try:
            me = await client.request(Account(token=token), "GET", "/me")
        except IRAError:
            me = None
        result = None
        if me and me["user"]["role"] in ROLE_TOOLS:
            result = AccessToken(
                token=token, client_id="ira", scopes=["ira"], resource=MCP_PUBLIC_URL,
                subject=str(me["user"]["id"]), claims={"user": me["user"], "hospital": me.get("hospital")},
            )
        if len(self._cache) > 5000:
            self._cache.clear()
        self._cache[key] = (time.monotonic() + self.TTL, result)
        return result


def _token_key(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


verifier = IRATokenVerifier()


def _current_account() -> Account | None:
    tok = get_access_token()
    if not tok or not tok.claims:
        return None
    return Account(token=tok.token, user=tok.claims["user"], hospital=tok.claims.get("hospital"))


def _visible_tools(acct: Account | None) -> set[str]:
    return ROLE_TOOLS.get(acct.role, set()) if acct else set()


class RoleGate(ServerMiddleware[Any]):
    """Lists and allows only the tools for the logged-in account's role."""

    async def __call__(self, ctx: ServerRequestContext[Any, Any], call_next: CallNext) -> HandlerResult:
        if ctx.method == "tools/call":
            name = (ctx.params or {}).get("name")
            acct = _current_account()
            if name not in _visible_tools(acct):
                who = _who(acct) if acct else "this connection"
                msg = (f"“{name}” isn't available to {who}. To use another account, reconnect the IRA "
                       "connector and log in as that account.")
                return CallToolResult(content=[TextContent(type="text", text=msg)], is_error=True)
        result = await call_next(ctx)
        if ctx.method == "tools/list" and result is not None:
            allowed = _visible_tools(_current_account())
            if isinstance(result, dict):
                result = {**result, "tools": [t for t in result.get("tools", []) if t.get("name") in allowed]}
            else:
                result = result.model_copy(update={"tools": [t for t in result.tools if t.name in allowed]})
        return result


mcp = MCPServer(
    name="ira",
    title="IRA Appointments",
    description="Book and manage hospital appointments as a patient or a hospital.",
    instructions=INSTRUCTIONS,
    version="2.0.0",
    log_level=os.environ.get("IRA_MCP_LOG_LEVEL", "WARNING"),
    token_verifier=verifier,
    auth=AuthSettings(
        issuer_url=IRA_URL,
        resource_server_url=MCP_PUBLIC_URL,
        required_scopes=["ira"],
        validate_token_resource=False,  # tokens are IRA sessions; the verifier checks them itself
    ),
    middleware=[RoleGate()],
)
logging.getLogger("httpx").setLevel(logging.WARNING)


async def _account(ctx: Context, role: str | None = None) -> Account:
    acct = _current_account()
    if not acct:
        raise ToolError("You're not logged in. Reconnect the IRA connector to log in.")
    if role and acct.role != role:
        raise ToolError(f"That is a {role} action, but you're logged in as {_who(acct)}.")
    return acct


def _who(acct: Account) -> str:
    u = acct.user or {}
    if acct.role == "hospital":
        return f"the hospital {acct.hospital['name'] if acct.hospital else u.get('name')}"
    return f"{u.get('name')} ({acct.role})"


@contextmanager
def friendly_errors():
    """Turn API and parsing errors into clean tool errors the model can relay or fix."""
    try:
        yield
    except ToolError:
        raise
    except (IRAError, ValueError) as exc:
        raise ToolError(str(exc)) from exc


async def _get(acct: Account, path: str) -> Any:
    return await client.request(acct, "GET", path)


# ---------------------------------------------------------------------------
# Formatting & lookup helpers
# ---------------------------------------------------------------------------
def _open_days(h: dict) -> list[int]:
    """Python weekday numbers (0 = Monday) the hospital is open."""
    return sorted(JS_TO_PY[int(d)] for d in h["days_open"].split(",") if d != "")


def _days_label(h: dict) -> str:
    days = set(_open_days(h))
    if not days:
        return "closed every day"
    if len(days) == 7:
        return "every day"
    starts = [d for d in days if (d - 1) % 7 not in days]
    if len(starts) == 1:
        s = starts[0]
        return DOW_SHORT[s] if len(days) == 1 else f"{DOW_SHORT[s]} to {DOW_SHORT[(s + len(days) - 1) % 7]}"
    return ", ".join(DOW_SHORT[d] for d in sorted(days))


def _hours(h: dict) -> str:
    return f"{_days_label(h)}, {fmt_time(h['open_time'])} to {fmt_time(h['close_time'])}"


def _is_open_on(h: dict, d: date) -> bool:
    return d.weekday() in _open_days(h)


def _is_open_now(h: dict) -> bool:
    return _is_open_on(h, today()) and h["open_time"] <= now_hhmm() < h["close_time"]


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]", " ", s.lower())


async def _resolve_hospital(acct: Account, query: str | int) -> dict:
    hospitals = await _get(acct, "/hospitals")
    q = str(query).strip()
    if q.isdigit():
        for h in hospitals:
            if h["id"] == int(q):
                return h
    words = [w for w in _norm(q).split() if w not in ("the", "at", "in")]
    exact = [h for h in hospitals if _norm(h["name"]).strip() == " ".join(words)]
    if len(exact) == 1:
        return exact[0]
    matches = [h for h in hospitals if all(w in _norm(f"{h['name']} {h['city']} {h['specialties']}") for w in words)]
    if not matches:  # be lenient: any meaningful word in the name
        matches = [h for h in hospitals if any(len(w) > 3 and w in _norm(h["name"]) for w in words)]
    if len(matches) == 1:
        return matches[0]
    if not matches:
        names = "; ".join(f"{h['name']} ({h['city']})" for h in hospitals)
        raise ToolError(f"No hospital matches “{q}”. Available hospitals: {names}.")
    names = "; ".join(f"{h['name']} in {h['city']} (id {h['id']})" for h in matches)
    raise ToolError(f"“{q}” matches more than one hospital: {names}. Which one did you mean?")


def _slot_list(times: list[str], limit: int = 12) -> str:
    shown = ", ".join(fmt_time(t) for t in times[:limit])
    return shown + (f", and {len(times) - limit} more" if len(times) > limit else "")


def _group_by_part(times: list[str]) -> str:
    parts = []
    for part in ("morning", "afternoon", "evening"):
        ts = [t for t in times if in_part_of_day(t, part)]
        if ts:
            parts.append(f"{part}: {_slot_list(ts, 8)}")
    return "; ".join(parts)


async def _doctor_slots(acct: Account, doc: dict, d: date, part: str | None = None) -> tuple[dict, list[str]]:
    data = await _get(acct, f"/doctors/{doc['id']}/slots?date={d.isoformat()}")
    free = [s["time"] for s in data["slots"] if s["status"] == "free" and in_part_of_day(s["time"], part)]
    return data, free


def _works_on(doc: dict, d: date) -> bool:
    return doc.get("available", True) and _is_open_on(doc, d) and d.isoformat() not in (doc.get("time_off") or [])


def _closed_reason(doc: dict, data: dict) -> str:
    reason = data.get("reason")
    if reason == "unavailable":
        return f"{doc['name']} isn't taking appointments right now"
    if reason == "day_off":
        return f"{doc['name']} is off that day"
    if reason == "past":
        return "that day has passed"
    return f"{doc['name']} doesn't work on {date.fromisoformat(data['date']).strftime('%A')}s"


def _doctor_line(doc: dict) -> str:
    bits = [doc["specialty"]]
    if doc.get("qualification"):
        bits.append(doc["qualification"])
    if doc.get("experience_years") is not None:
        bits.append(f"{doc['experience_years']} years' experience")
    line = f"{doc['name']} ({', '.join(bits)}). Works {_hours(doc)}, {doc['slot_minutes']}-minute appointments"
    if doc.get("consultation_fee") is not None:
        line += f", fee ₹{doc['consultation_fee']}"
    if not doc.get("available", True):
        line += ". NOT taking appointments right now"
    upcoming_off = [x for x in (doc.get("time_off") or []) if x >= today().isoformat()][:3]
    if upcoming_off:
        line += ". Days off: " + ", ".join(fmt_date(x).split(" (")[0] if not fmt_date(x).startswith(("today", "tomorrow")) else fmt_date(x) for x in upcoming_off)
    return f"{line}. [doctor id {doc['id']}]"


# Spoken ways of naming a specialty → a stem that appears in the specialty name.
SPECIALTY_WORDS = {
    "cardiologist": "cardio", "heart": "cardio", "dermatologist": "derma", "skin": "derma",
    "neurologist": "neuro", "brain": "neuro", "nerve": "neuro", "pediatrician": "pediat", "paediatrician": "pediat",
    "child": "pediat", "children": "pediat", "kids": "pediat", "baby": "neonat", "newborn": "neonat",
    "orthopedic": "ortho", "orthopaedic": "ortho", "bone": "ortho", "bones": "ortho", "joint": "ortho",
    "dentist": "dent", "teeth": "dent", "tooth": "dent", "dental": "dent", "eye": "ophthal", "eyes": "ophthal",
    "ophthalmologist": "ophthal", "ent": "ent", "ear": "ent", "nose": "ent", "throat": "ent",
    "physician": "general", "gp": "general", "general": "general", "gynecologist": "gyn", "gynaecologist": "gyn",
}
_FILLER = {"dr", "doctor", "the", "a", "an", "specialist", "doc", "sir", "madam", "mam", "maam", "with", "of"}


def _match_doctors(doctors: list[dict], query: str) -> list[dict]:
    q = str(query).strip()
    if q.isdigit():
        return [d for d in doctors if d["id"] == int(q)]
    words = [w for w in _norm(q).split() if w not in _FILLER]
    if not words:
        return []
    exact = [d for d in doctors if _norm(d["name"]).replace("dr ", "").strip() == " ".join(words)]
    if exact:
        return exact

    def hit(d: dict, w: str) -> bool:
        hay = _norm(f"{d['name']} {d['specialty']} {d.get('qualification', '')}")
        stem = SPECIALTY_WORDS.get(w, w[:5] if len(w) > 5 else w)
        return any(tok.startswith(w) for tok in hay.split()) or stem in hay

    return [d for d in doctors if all(hit(d, w) for w in words)]


def _list_names(doctors: list[dict]) -> str:
    return "; ".join(f"{d['name']} ({d['specialty']})" for d in doctors)


def _pick_doctor(doctors: list[dict], query: str | None, place: str) -> dict:
    """Resolve a loosely named doctor, or raise a helpful error that lists the options."""
    if not doctors:
        raise ToolError(f"{place} hasn't added any doctors yet.")
    if not query:
        if len(doctors) == 1:
            return doctors[0]
        raise ToolError(f"Which doctor? {place} has {len(doctors)}: {_list_names(doctors)}. Ask the user, then call again with doctor=.")
    found = _match_doctors(doctors, query)
    if len(found) == 1:
        return found[0]
    if not found:
        raise ToolError(f"No doctor matching “{query}” at {place}. Doctors there: {_list_names(doctors)}.")
    raise ToolError(f"“{query}” matches several doctors at {place}: {_list_names(found)}. Which one?")


def _patient_appt_line(a: dict) -> str:
    doctor = f"{a['doctor_name']} ({a['doctor_specialty']}) at " if a.get("doctor_name") else ""
    line = f"{fmt_date(a['date'])} at {fmt_time(a['time'])}, {doctor}{a['hospital_name']} — {a['status']}"
    if a.get("reason"):
        line += f", reason: {a['reason']}"
    return f"{line} [appointment id {a['id']}]"


def _hospital_appt_line(a: dict, with_date: bool = False, with_doctor: bool = True) -> str:
    when = f"{fmt_date(a['date'])} " if with_date else ""
    doctor = f" with {a['doctor_name']}" if with_doctor and a.get("doctor_name") else ""
    line = f"{when}{fmt_time(a['time'])} — {a['patient_name']}{doctor} ({a['status']})"
    if a.get("reason"):
        line += f", reason: {a['reason']}"
    if a.get("patient_phone"):
        line += f", phone {a['patient_phone']}"
    return f"{line} [appointment id {a['id']}]"


def _split_dates(value: str | None) -> list[str]:
    if not value:
        return []
    parts = [p.strip() for p in re.split(r",|;|\band\b", str(value)) if p.strip()]
    return sorted({parse_date(p).isoformat() for p in parts})


def _is_upcoming(a: dict) -> bool:
    t = today().isoformat()
    return a["status"] == "booked" and (a["date"] > t or (a["date"] == t and a["time"] >= now_hhmm()))


async def _hospital_appointments(acct: Account, start: date, end: date) -> list[dict]:
    return await _get(acct, f"/appointments?from={start.isoformat()}&to={end.isoformat()}")


async def _find_patient_appointment(acct: Account, appointment_id: int) -> dict:
    mine = await _get(acct, "/appointments")
    for a in mine:
        if a["id"] == appointment_id:
            return a
    raise ToolError(f"I couldn't find appointment {appointment_id} in your appointments. Use my_appointments to list them.")


async def _find_hospital_appointment(acct: Account, appointment_id: int) -> dict:
    t = today()
    for a in await _hospital_appointments(acct, t - timedelta(days=120), t + timedelta(days=90)):
        if a["id"] == appointment_id:
            return a
    raise ToolError(f"Appointment {appointment_id} isn't in this hospital's records. Use get_schedule to find it.")


def _parse_days(value: str | list[str]) -> list[int]:
    """'Mon-Sat', 'weekdays', 'every day', ['monday', 'wed'] → Python weekday numbers."""
    text = " ".join(value) if isinstance(value, list) else str(value)
    t = text.lower().strip()
    if t in ("every day", "everyday", "daily", "all", "all days", "all week"):
        return list(range(7))
    if t in ("weekdays", "week days", "monday to friday"):
        return list(range(5))
    if t in ("weekends", "weekend"):
        return [5, 6]

    def idx(word: str) -> int:
        for i, name in enumerate(WEEKDAYS):
            if name.startswith(word[:3]):
                return i
        raise ValueError(f"“{word}” isn't a day of the week.")

    days: set[int] = set()
    for part in re.split(r"[,&]|\band\b", t):
        part = part.strip()
        if not part:
            continue
        if m := re.fullmatch(r"([a-z]+)\s*(?:-|to|–|through)\s*([a-z]+)", part):
            a, b = idx(m.group(1)), idx(m.group(2))
            days.update((a + i) % 7 for i in range((b - a) % 7 + 1))
        else:
            days.update(idx(w) for w in part.split())
    if not days:
        raise ValueError("Please name at least one working day.")
    return sorted(days)


# ---------------------------------------------------------------------------
# Account tools (everyone)
# ---------------------------------------------------------------------------
@mcp.tool(title="Who am I", annotations=READ)
async def whoami(ctx: Context) -> str:
    """Show which IRA account you're acting as, plus today's date and the current time."""
    acct = await _account(ctx)
    t = today()
    clock = f"Today is {t.strftime('%A')}, {t.day} {t.strftime('%B %Y')}, and the time is {fmt_time(now_hhmm())}."
    u = acct.user
    if acct.role == "hospital":
        h = acct.hospital or {}
        detail = f"You're logged in as the hospital {h.get('name')} in {h.get('city')} (open {_hours(h)})." if h else "You're logged in as a hospital."
    else:
        detail = f"You're logged in as {u['name']}, a patient ({u['email']})."
    return f"{detail} {clock}"


@mcp.tool(title="Notifications", annotations=WRITE)
async def notifications(ctx: Context, mark_as_read: bool = True) -> str:
    """Read the latest notifications for the current account (new bookings, cancellations, confirmations)."""
    with friendly_errors():
        acct = await _account(ctx)
        data = await _get(acct, "/notifications")
        if mark_as_read and data["unread"]:
            await client.request(acct, "POST", "/notifications/read")
    items = data["items"][:10]
    if not items:
        return "No notifications."
    unread = data["unread"]
    lines = [f"- {'(new) ' if not n['read'] else ''}{n['message']}" for n in items]
    return f"{unread} unread. Latest notifications:\n" + "\n".join(lines)


# ---------------------------------------------------------------------------
# Patient tools
# ---------------------------------------------------------------------------
@mcp.tool(title="List hospitals", annotations=READ)
async def list_hospitals(ctx: Context, search: str | None = None) -> str:
    """[Patient] List hospitals, optionally filtered by hospital name, city, specialty or doctor name."""
    with friendly_errors():
        acct = await _account(ctx)
        hospitals = await _get(acct, "/hospitals")
    if search:
        words = _norm(search).split()
        hay = lambda h: _norm(f"{h['name']} {h['city']} {h['specialties']} {h.get('doctor_specialties') or ''} {h.get('doctor_names') or ''}")  # noqa: E731
        hospitals = [h for h in hospitals if all(w in hay(h) for w in words)]
    if not hospitals:
        return f"No hospitals match “{search}”."
    lines = []
    for h in hospitals:
        n = h.get("doctor_count") or 0
        docs = f"{n} doctor{'s' if n != 1 else ''} ({h.get('doctor_specialties')})" if n else "no doctors yet"
        lines.append(f"- {h['name']} in {h['city']}: {docs}. Open {_hours(h)}{' (open now)' if _is_open_now(h) else ''}. [hospital id {h['id']}]")
    return f"{len(hospitals)} hospital{'s' if len(hospitals) != 1 else ''}:\n" + "\n".join(lines)


@mcp.tool(title="Hospital details", annotations=READ)
async def get_hospital(hospital: str, ctx: Context) -> str:
    """[Patient] Details for one hospital (address, phone, hours) and its doctors."""
    with friendly_errors():
        acct = await _account(ctx)
        h = await _resolve_hospital(acct, hospital)
        doctors = await _get(acct, f"/hospitals/{h['id']}/doctors")
    head = (f"{h['name']}, {h['address'] or h['city']}. Phone {h['phone'] or 'not listed'}. Open {_hours(h)}; "
            f"it is {'open' if _is_open_now(h) else 'closed'} right now. [hospital id {h['id']}]")
    if not doctors:
        return head + "\nNo doctors have been added yet."
    return head + f"\nDoctors ({len(doctors)}):\n" + "\n".join(f"- {_doctor_line(d)}" for d in doctors)


@mcp.tool(title="List doctors", annotations=READ)
async def list_doctors(hospital: str, ctx: Context, specialty: str | None = None) -> str:
    """[Patient] The doctors at a hospital with specialty, qualification, timings, fee and availability."""
    with friendly_errors():
        acct = await _account(ctx)
        h = await _resolve_hospital(acct, hospital)
        doctors = await _get(acct, f"/hospitals/{h['id']}/doctors")
    if specialty:
        doctors = _match_doctors(doctors, specialty)
    if not doctors:
        return f"No {specialty + ' ' if specialty else ''}doctors at {h['name']}."
    return f"{h['name']} has {len(doctors)} doctor{'s' if len(doctors) != 1 else ''}{f' for {specialty}' if specialty else ''}:\n" + \
        "\n".join(f"- {_doctor_line(d)}" for d in doctors)


@mcp.tool(title="Find doctors", annotations=READ)
async def find_doctors(search: str, ctx: Context, city: str | None = None) -> str:
    """[Patient] Search doctors across all hospitals by name or specialty (e.g. "cardiology", "Dr. Reddy"), optionally in a city."""
    with friendly_errors():
        acct = await _account(ctx)
        words = [w for w in _norm(search).split() if w not in _FILLER]
        term = SPECIALTY_WORDS.get(words[0], words[0]) if len(words) == 1 else " ".join(words)
        params = {"q": term}
        if city:
            params["city"] = city
        found = await client.request(acct, "GET", "/doctors?" + "&".join(f"{k}={quote(str(v))}" for k, v in params.items()))
    if not found:
        return f"No doctors found for “{search}”{f' in {city}' if city else ''}."
    lines = [f"- {_doctor_line(d)} At {d['hospital_name']}, {d['hospital_city']}." for d in found[:15]]
    return f"{len(found)} doctor{'s' if len(found) != 1 else ''} found:\n" + "\n".join(lines)


@mcp.tool(title="Check availability", annotations=READ)
async def check_availability(
    hospital: str, ctx: Context, doctor: str | None = None, date: str = "today", part_of_day: PartOfDay = "any",
) -> str:
    """[Patient] Free appointment times with a doctor on one date.

    If `doctor` is left out and the hospital has several doctors, this returns each doctor's free
    slots for that date so you can ask the user which doctor they want.
    """
    with friendly_errors():
        acct = await _account(ctx)
        h = await _resolve_hospital(acct, hospital)
        doctors = await _get(acct, f"/hospitals/{h['id']}/doctors")
        d = parse_date(date)
        if d < today():
            raise ToolError(f"{fmt_date(d)} is in the past. Pick today or a later date.")
        part = "" if part_of_day == "any" else f" in the {part_of_day}"
        if not doctor and len(doctors) > 1:
            lines = []
            for doc in doctors:
                data, free = await _doctor_slots(acct, doc, d, part_of_day)
                if not data["open"]:
                    lines.append(f"- {doc['name']} ({doc['specialty']}): not available, {_closed_reason(doc, data)}")
                else:
                    first = f", from {fmt_time(free[0])}" if free else ""
                    lines.append(f"- {doc['name']} ({doc['specialty']}): {len(free)} free slot{'s' if len(free) != 1 else ''}{part}{first}")
            return (f"{h['name']} has {len(doctors)} doctors. Free slots {on_date(d)}:\n" + "\n".join(lines)
                    + "\nAsk the user which doctor they'd like, then call again with doctor=.")
        doc = _pick_doctor(doctors, doctor, h["name"])
        data, free = await _doctor_slots(acct, doc, d, part_of_day)
    when = on_date(d)
    if not data["open"]:
        nxt = next((d + timedelta(days=i) for i in range(1, 22) if _works_on(doc, d + timedelta(days=i))), None)
        tail = f" Their next working day is {fmt_date(nxt)}." if nxt else ""
        return f"No slots {when}: {_closed_reason(doc, data)}. {doc['name']} works {_hours(doc)}.{tail}"
    if not free:
        return f"{doc['name']} has no free slots{part} {when}. Try find_next_available for the next opening."
    listing = _slot_list(free) if part_of_day != "any" else _group_by_part(free)
    return f"{doc['name']} ({doc['specialty']}) at {h['name']} has {len(free)} free slot{'s' if len(free) != 1 else ''}{part} {when}: {listing}."


@mcp.tool(title="Find next available", annotations=READ)
async def find_next_available(
    hospital: str, ctx: Context, doctor: str | None = None, starting: str = "today",
    part_of_day: PartOfDay = "any", how_many: int = 5,
) -> str:
    """[Patient] The earliest free times with a doctor, searching up to 3 weeks ahead.

    If `doctor` is left out and the hospital has several doctors, this returns each doctor's
    earliest slot so the user can choose.
    """
    with friendly_errors():
        acct = await _account(ctx)
        h = await _resolve_hospital(acct, hospital)
        doctors = await _get(acct, f"/hospitals/{h['id']}/doctors")
        start = max(parse_date(starting), today())

        async def earliest(doc: dict, limit: int) -> list[tuple[date, str]]:
            found: list[tuple[date, str]] = []
            for i in range(21):
                d = start + timedelta(days=i)
                if not _works_on(doc, d):
                    continue
                _, free = await _doctor_slots(acct, doc, d, part_of_day)
                found.extend((d, t) for t in free)
                if len(found) >= limit:
                    break
            return found[:limit]

        if not doctor and len(doctors) > 1:
            lines = []
            for doc in doctors:
                if not doc.get("available", True):
                    lines.append(f"- {doc['name']} ({doc['specialty']}): not taking appointments right now")
                    continue
                first = await earliest(doc, 1)
                lines.append(f"- {doc['name']} ({doc['specialty']}): " + (f"{fmt_date(first[0][0])} at {fmt_time(first[0][1])}" if first else "nothing in the next three weeks"))
            return (f"Earliest free slot with each doctor at {h['name']}:\n" + "\n".join(lines)
                    + "\nAsk the user which doctor they'd like, then call again with doctor=.")
        doc = _pick_doctor(doctors, doctor, h["name"])
        found = await earliest(doc, max(1, min(how_many, 20)))
    if not found:
        return f"{doc['name']} has no free slots in the next three weeks."
    by_day: dict[date, list[str]] = {}
    for d, t in found:
        by_day.setdefault(d, []).append(t)
    first_d, first_t = found[0]
    rest = "; ".join(f"{fmt_date(d)}: {_slot_list(ts)}" for d, ts in by_day.items())
    return f"The earliest free slot with {doc['name']} is {fmt_date(first_d)} at {fmt_time(first_t)}. Options — {rest}."


@mcp.tool(title="Book appointment", annotations=WRITE)
async def book_appointment(hospital: str, doctor: str, date: str, time: str, ctx: Context, reason: str = "") -> str:
    """[Patient] Book an appointment with a doctor. Confirm the doctor, date and time with the user first.

    `doctor` can be a name or specialty ("Dr. Desai", "the cardiologist"). `date`/`time` can be natural.
    """
    with friendly_errors():
        acct = await _account(ctx, "patient")
        h = await _resolve_hospital(acct, hospital)
        doc = _pick_doctor(await _get(acct, f"/hospitals/{h['id']}/doctors"), doctor, h["name"])
        d, t = parse_date(date), parse_time(time)
        try:
            a = await client.request(acct, "POST", "/appointments",
                                     {"doctorId": doc["id"], "hospitalId": h["id"], "date": d.isoformat(), "time": t, "reason": reason})
        except IRAError as exc:
            hint = ""
            if _works_on(doc, d) and d >= today():
                _, free = await _doctor_slots(acct, doc, d)
                if free:
                    nearest = sorted(free, key=lambda x: abs(int(x[:2]) * 60 + int(x[3:]) - int(t[:2]) * 60 - int(t[3:])))[:4]
                    hint = f" {doc['name']} is free that day at {_slot_list(sorted(nearest))}."
            raise ToolError(f"Couldn't book: {str(exc).rstrip('.')}.{hint}") from exc
    return (
        f"Booked! {doc['name']} ({doc['specialty']}) at {h['name']} {on_date(a['date'])} at {fmt_time(a['time'])}"
        f"{f' for {reason}' if reason else ''}. A confirmation has been sent. [appointment id {a['id']}]"
    )


@mcp.tool(title="My appointments", annotations=READ)
async def my_appointments(
    ctx: Context, which: Literal["upcoming", "past", "all"] = "upcoming", hospital: str | None = None,
) -> str:
    """[Patient] List the patient's appointments (with doctor and hospital): upcoming (default), past (history incl. cancelled), or all."""
    with friendly_errors():
        acct = await _account(ctx, "patient")
        appts = await _get(acct, "/appointments")
        if hospital:
            h = await _resolve_hospital(acct, hospital)
            appts = [a for a in appts if a["hospital_id"] == h["id"]]
    key = lambda a: (a["date"], a["time"])  # noqa: E731
    if which == "upcoming":
        rows, label = sorted([a for a in appts if _is_upcoming(a)], key=key), "upcoming"
    elif which == "past":
        rows, label = sorted([a for a in appts if not _is_upcoming(a)], key=key, reverse=True)[:20], "past or cancelled"
    else:
        rows, label = sorted(appts, key=key, reverse=True)[:30], ""
    if not rows:
        return f"You have no {label} appointments{' there' if hospital else ''}."
    head = f"You have {len(rows)} {label} appointment{'s' if len(rows) != 1 else ''}".replace("  ", " ")
    return f"{head}:\n" + "\n".join(f"- {_patient_appt_line(a)}" for a in rows)


@mcp.tool(title="Reschedule appointment", annotations=WRITE)
async def reschedule_appointment(appointment_id: int, new_date: str, new_time: str, ctx: Context) -> str:
    """[Patient] Move a booked appointment to a new date and time with the same doctor."""
    with friendly_errors():
        acct = await _account(ctx, "patient")
        old = await _find_patient_appointment(acct, appointment_id)
        d, t = parse_date(new_date), parse_time(new_time)
        a = await client.request(acct, "POST", f"/appointments/{appointment_id}/reschedule", {"date": d.isoformat(), "time": t})
    return (
        f"Rescheduled. Your appointment with {a['doctor_name']} at {a['hospital_name']} moved from {fmt_date(old['date'])} at "
        f"{fmt_time(old['time'])} to {fmt_date(a['date'])} at {fmt_time(a['time'])}."
    )


@mcp.tool(title="Update my profile", annotations=WRITE)
async def update_my_profile(ctx: Context, name: str | None = None, phone: str | None = None) -> str:
    """[Patient or hospital] Change the signed-in user's display name and/or phone number."""
    with friendly_errors():
        acct = await _account(ctx)
        u = acct.user
        user = await client.request(acct, "PUT", "/me", {"name": name or u["name"], "phone": phone if phone is not None else u.get("phone", "")})
        verifier.forget(acct.token)
    return f"Profile updated: {user['name']}, phone {user['phone'] or 'not set'}."


# ---------------------------------------------------------------------------
# Shared: cancel
# ---------------------------------------------------------------------------
@mcp.tool(title="Cancel appointment", annotations=DESTRUCTIVE)
async def cancel_appointment(appointment_id: int, ctx: Context) -> str:
    """[Patient or hospital] Cancel a booked appointment. Always confirm with the user first.

    Patients can cancel their own appointments; hospitals can cancel any of theirs (the patient is notified).
    """
    with friendly_errors():
        acct = await _account(ctx)
        if acct.role == "patient":
            a = await _find_patient_appointment(acct, appointment_id)
            who = f"{a['doctor_name']} at {a['hospital_name']}" if a.get("doctor_name") else a["hospital_name"]
        elif acct.role == "hospital":
            a = await _find_hospital_appointment(acct, appointment_id)
            who = f"{a['patient_name']} ({a['doctor_name']})" if a.get("doctor_name") else a["patient_name"]
        else:
            raise ToolError("Only patient or hospital accounts can cancel appointments.")
        await client.request(acct, "PATCH", f"/appointments/{appointment_id}", {"status": "cancelled"})
    notified = "The patient has been notified." if acct.role == "hospital" else "The hospital has been notified."
    return f"Cancelled the appointment with {who} {on_date(a['date'])} at {fmt_time(a['time'])}. {notified}"


# ---------------------------------------------------------------------------
# Hospital tools
# ---------------------------------------------------------------------------
async def _my_doctors(acct: Account) -> list[dict]:
    return await _get(acct, "/hospital/doctors")


def _per_doctor_counts(doctors: list[dict], appts: list[dict]) -> str:
    counts: dict[int, int] = {}
    for x in appts:
        if x["status"] != "cancelled":
            counts[x["doctor_id"]] = counts.get(x["doctor_id"], 0) + 1
    return "\n".join(f"- {d['name']} ({d['specialty']}): {counts.get(d['id'], 0) or 'no'} appointment{'s' if counts.get(d['id'], 0) != 1 else ''}"
                     + ("" if d.get("available", True) else " — currently unavailable") for d in doctors)


def _doctor_choice(acct_doctors: list[dict], doctor: str | None, place: str) -> dict | None:
    """None means "all doctors"; raises (listing options) if the name doesn't match."""
    if doctor and doctor.strip().lower() in ("all", "all doctors", "everyone", "every doctor", "any"):
        return None
    return _pick_doctor(acct_doctors, doctor, place)


@mcp.tool(title="Hospital summary", annotations=READ)
async def hospital_summary(ctx: Context) -> str:
    """[Hospital] Quick briefing: today's appointments per doctor, who's next, and the coming week."""
    with friendly_errors():
        acct = await _account(ctx, "hospital")
        t = today()
        appts = await _hospital_appointments(acct, t, t + timedelta(days=6))
        doctors = await _my_doctors(acct)
    active = [a for a in appts if a["status"] != "cancelled"]
    todays = [a for a in active if a["date"] == t.isoformat()]
    remaining = sorted([a for a in todays if a["status"] == "booked" and a["time"] >= now_hhmm()], key=lambda a: a["time"])
    name = acct.hospital["name"] if acct.hospital else "Your hospital"
    parts = [f"{name} has {len(doctors)} doctor{'s' if len(doctors) != 1 else ''} and {len(todays)} appointment{'s' if len(todays) != 1 else ''} today, {len(remaining)} still to come."]
    if doctors and todays:
        parts.append("Today by doctor:\n" + _per_doctor_counts(doctors, todays))
    if remaining:
        n = remaining[0]
        reason = f" for {n['reason']}" if n.get("reason") else ""
        parts.append(f"Next up: {n['patient_name']} with {n['doctor_name']} at {fmt_time(n['time'])}{reason}.")
    parts.append(f"Next 6 days: {len(active) - len(todays)} more bookings.")
    if not doctors:
        parts.append("No doctors added yet: patients can't book until you add one (use add_doctor).")
    return "\n".join(parts)


@mcp.tool(title="My doctors", annotations=READ)
async def my_doctors(ctx: Context) -> str:
    """[Hospital] This hospital's doctors with specialty, timings, days off, availability and today's/upcoming counts."""
    with friendly_errors():
        acct = await _account(ctx, "hospital")
        doctors = await _my_doctors(acct)
    if not doctors:
        return "No doctors yet. Add one with add_doctor (name, specialty and timings)."
    lines = [f"- {_doctor_line(d)} Today: {d.get('today', 0)}, upcoming: {d.get('upcoming', 0)}." for d in doctors]
    return f"{len(doctors)} doctor{'s' if len(doctors) != 1 else ''}:\n" + "\n".join(lines)


@mcp.tool(title="Schedule for a date", annotations=READ)
async def get_schedule(ctx: Context, date: str = "today", doctor: str | None = None, include_cancelled: bool = False) -> str:
    """[Hospital] Appointments on one date for a doctor, in time order (patient, reason, phone).

    If `doctor` is left out and the hospital has several doctors, this returns each doctor's
    count for that date. Ask the user which doctor, then call again with `doctor=` (a name,
    specialty, or "all").
    """
    with friendly_errors():
        acct = await _account(ctx, "hospital")
        d = parse_date(date)
        doctors = await _my_doctors(acct)
        appts = await _hospital_appointments(acct, d, d)
        place = acct.hospital["name"] if acct.hospital else "This hospital"
        when = on_date(d)
        if not doctor and len(doctors) > 1:
            total = len([a for a in appts if a["status"] != "cancelled"])
            return (f"{place} has {total} appointment{'s' if total != 1 else ''} {when} across {len(doctors)} doctors:\n"
                    + _per_doctor_counts(doctors, appts)
                    + "\nAsk the user which doctor's schedule they want (or all), then call again with doctor=.")
        doc = _doctor_choice(doctors, doctor, place) if doctors else None
    rows = [a for a in appts if (doc is None or a["doctor_id"] == doc["id"]) and (include_cancelled or a["status"] != "cancelled")]
    cancelled = len([a for a in appts if (doc is None or a["doctor_id"] == doc["id"]) and a["status"] == "cancelled"])
    note = f" ({cancelled} cancelled not shown)" if cancelled and not include_cancelled else ""
    who = f"{doc['name']} has" if doc else ("There is" if len(rows) == 1 else "There are")
    if not rows:
        extra = ""
        if doc and not _is_open_on(doc, d):
            extra = f" {doc['name']} doesn't work that day."
        elif doc and d.isoformat() in (doc.get("time_off") or []):
            extra = f" {doc['name']} is off that day."
        return f"{who} no appointments {when}{note}.{extra}"
    lines = "\n".join(f"- {_hospital_appt_line(a, with_doctor=doc is None)}" for a in sorted(rows, key=lambda a: (a["time"], a.get("doctor_name", ""))))
    return f"{who} {len(rows)} appointment{'s' if len(rows) != 1 else ''} {when}{note}:\n{lines}"


@mcp.tool(title="Appointments in a date range", annotations=READ)
async def get_appointments(
    ctx: Context, from_date: str = "today", to_date: str = "in 7 days", doctor: str | None = None,
    status: Literal["any", "booked", "completed", "cancelled"] = "any",
) -> str:
    """[Hospital] Appointment records between two dates (inclusive), grouped by day.

    If `doctor` is left out and there are several doctors, this returns counts per doctor first;
    ask the user which doctor (or all), then call again with `doctor=`.
    """
    with friendly_errors():
        acct = await _account(ctx, "hospital")
        start, end = parse_date(from_date), parse_date(to_date)
        if end < start:
            start, end = end, start
        if (end - start).days > 92:
            raise ToolError("Please ask for at most about three months at a time.")
        doctors = await _my_doctors(acct)
        appts = await _hospital_appointments(acct, start, end)
        place = acct.hospital["name"] if acct.hospital else "This hospital"
        if status != "any":
            appts = [a for a in appts if a["status"] == status]
        span = f"from {fmt_date(start)} to {fmt_date(end)}"
        if not doctor and len(doctors) > 1:
            return (f"{len(appts)} {'' if status == 'any' else status + ' '}appointment{'s' if len(appts) != 1 else ''} {span} across {len(doctors)} doctors:\n"
                    + _per_doctor_counts(doctors, appts)
                    + "\nAsk the user which doctor (or all), then call again with doctor=.")
        doc = _doctor_choice(doctors, doctor, place) if doctors else None
    if doc:
        appts = [a for a in appts if a["doctor_id"] == doc["id"]]
    if not appts:
        who = f" for {doc['name']}" if doc else ""
        return f"No {'' if status == 'any' else status + ' '}appointments{who} {span}."
    by_day: dict[str, list[dict]] = {}
    for a in appts:
        by_day.setdefault(a["date"], []).append(a)
    out = [f"{len(appts)} appointment{'s' if len(appts) != 1 else ''}{f' for {doc['name']}' if doc else ''} {span}:"]
    for d, rows in sorted(by_day.items()):
        out.append(f"{fmt_date(d)} — {len(rows)}:")
        out.extend(f"  - {_hospital_appt_line(a, with_doctor=doc is None)}" for a in sorted(rows, key=lambda a: a["time"])[:15])
    return "\n".join(out[:120])


@mcp.tool(title="Mark appointment completed", annotations=WRITE)
async def complete_appointment(appointment_id: int, ctx: Context) -> str:
    """[Hospital] Mark a booked appointment as completed (the patient was seen)."""
    with friendly_errors():
        acct = await _account(ctx, "hospital")
        a = await _find_hospital_appointment(acct, appointment_id)
        await client.request(acct, "PATCH", f"/appointments/{appointment_id}", {"status": "completed"})
    return f"Marked {a['patient_name']}'s appointment with {a['doctor_name']} {on_date(a['date'])} at {fmt_time(a['time'])} as completed."


@mcp.tool(title="List patients", annotations=READ)
async def list_patients(ctx: Context, search: str | None = None) -> str:
    """[Hospital] Patients who have booked with this hospital, with visit counts and doctors seen. Optionally search by name, email or phone."""
    with friendly_errors():
        acct = await _account(ctx, "hospital")
        patients = await _get(acct, "/hospital/patients")
    if search:
        q = _norm(search)
        patients = [p for p in patients if all(w in _norm(f"{p['name']} {p['email']} {p['phone']}") for w in q.split())]
    if not patients:
        return f"No patients match “{search}”." if search else "No patients have booked yet."
    lines = [
        f"- {p['name']} — {p['visits']} visit{'s' if p['visits'] != 1 else ''}, {p['upcoming'] or 0} upcoming, "
        f"last on {fmt_date(p['last_date'])}, seen by {p.get('doctors') or 'n/a'}. Phone {p['phone'] or 'n/a'}, email {p['email']}. [patient id {p['id']}]"
        for p in patients[:40]
    ]
    return f"{len(patients)} patient{'s' if len(patients) != 1 else ''}:\n" + "\n".join(lines)


@mcp.tool(title="Patient history", annotations=READ)
async def patient_history(patient: str, ctx: Context) -> str:
    """[Hospital] One patient's appointment history at this hospital (past and upcoming, with doctors). `patient` is a name, email or patient id."""
    with friendly_errors():
        acct = await _account(ctx, "hospital")
        patients = await _get(acct, "/hospital/patients")
        q = str(patient).strip()
        if q.isdigit():
            matches = [p for p in patients if p["id"] == int(q)]
        else:
            words = _norm(q).split()
            matches = [p for p in patients if all(w in _norm(f"{p['name']} {p['email']}") for w in words)]
        if not matches:
            raise ToolError(f"No patient called “{q}” has booked with this hospital.")
        if len(matches) > 1:
            raise ToolError("Several patients match: " + "; ".join(f"{p['name']} ({p['email']}, id {p['id']})" for p in matches) + ". Which one?")
        p = matches[0]
        t = today()
        appts = [a for a in await _hospital_appointments(acct, t - timedelta(days=365), t + timedelta(days=60)) if a["patient_id"] == p["id"]]
    appts.sort(key=lambda a: (a["date"], a["time"]), reverse=True)
    lines = "\n".join(f"- {_hospital_appt_line(a, with_date=True)}" for a in appts[:30])
    return (f"{p['name']} ({p['email']}, phone {p['phone'] or 'n/a'}) has {len(appts)} appointment"
            f"{'s' if len(appts) != 1 else ''} here:\n{lines}")


def _doctor_payload(current: dict, *, name=None, specialty=None, qualification=None, experience_years=None,
                    consultation_fee=None, phone=None, email=None, bio=None, working_days=None, start_time=None,
                    end_time=None, appointment_minutes=None, available=None, time_off=None) -> dict:
    days = _parse_days(working_days) if working_days else [JS_TO_PY[int(x)] for x in str(current.get("days_open", "1,2,3,4,5,6")).split(",") if x != ""]
    return {
        "name": name if name is not None else current.get("name"),
        "specialty": specialty if specialty is not None else current.get("specialty"),
        "qualification": qualification if qualification is not None else current.get("qualification", ""),
        "experience_years": experience_years if experience_years is not None else current.get("experience_years"),
        "consultation_fee": consultation_fee if consultation_fee is not None else current.get("consultation_fee"),
        "phone": phone if phone is not None else current.get("phone", ""),
        "email": email if email is not None else current.get("email", ""),
        "bio": bio if bio is not None else current.get("bio", ""),
        "open_time": parse_time(start_time) if start_time else current.get("open_time", "09:00"),
        "close_time": parse_time(end_time) if end_time else current.get("close_time", "17:00"),
        "slot_minutes": appointment_minutes or current.get("slot_minutes", 30),
        "days_open": [PY_TO_JS[d] for d in days],
        "available": available if available is not None else current.get("available", True),
        "time_off": time_off if time_off is not None else current.get("time_off", []),
    }


@mcp.tool(title="Add doctor", annotations=WRITE)
async def add_doctor(
    name: str, specialty: str, ctx: Context, qualification: str = "", experience_years: int | None = None,
    consultation_fee: int | None = None, phone: str = "", email: str = "", bio: str = "",
    working_days: str | None = None, start_time: str | None = None, end_time: str | None = None,
    appointment_minutes: Literal[10, 15, 20, 30, 45, 60] | None = None, days_off: str | None = None,
) -> str:
    """[Hospital] Add a doctor. Confirm the details with the user first.

    Timings default to the hospital's opening hours. `working_days` like "Mon-Sat" or "Mon, Wed, Fri";
    times like "9 am"; `days_off` like "25 Dec, 31 Dec".
    """
    with friendly_errors():
        acct = await _account(ctx, "hospital")
        h = await _get(acct, "/hospital/settings")
        defaults = {"open_time": h["open_time"], "close_time": h["close_time"], "slot_minutes": h["slot_minutes"], "days_open": h["days_open"]}
        payload = _doctor_payload(defaults, name=name, specialty=specialty, qualification=qualification,
                                  experience_years=experience_years, consultation_fee=consultation_fee, phone=phone,
                                  email=email, bio=bio, working_days=working_days, start_time=start_time,
                                  end_time=end_time, appointment_minutes=appointment_minutes, available=True,
                                  time_off=_split_dates(days_off))
        doc = await client.request(acct, "POST", "/hospital/doctors", payload)
    return f"Added {_doctor_line(doc)} Patients can book with them right away."


@mcp.tool(title="Update doctor", annotations=WRITE)
async def update_doctor(
    doctor: str, ctx: Context, name: str | None = None, specialty: str | None = None, qualification: str | None = None,
    experience_years: int | None = None, consultation_fee: int | None = None, phone: str | None = None,
    email: str | None = None, bio: str | None = None, working_days: str | None = None, start_time: str | None = None,
    end_time: str | None = None, appointment_minutes: Literal[10, 15, 20, 30, 45, 60] | None = None,
    available: bool | None = None, add_days_off: str | None = None, remove_days_off: str | None = None,
) -> str:
    """[Hospital] Change a doctor's details, timings or availability. Only the fields you pass change.

    `available=False` stops new bookings (existing ones stay). `add_days_off` / `remove_days_off`
    take dates like "tomorrow, 25 Dec". Confirm changes with the user first.
    """
    with friendly_errors():
        acct = await _account(ctx, "hospital")
        place = acct.hospital["name"] if acct.hospital else "This hospital"
        doc = _pick_doctor(await _my_doctors(acct), doctor, place)
        off = set(doc.get("time_off") or [])
        off |= set(_split_dates(add_days_off))
        off -= set(_split_dates(remove_days_off))
        payload = _doctor_payload(doc, name=name, specialty=specialty, qualification=qualification,
                                  experience_years=experience_years, consultation_fee=consultation_fee, phone=phone,
                                  email=email, bio=bio, working_days=working_days, start_time=start_time,
                                  end_time=end_time, appointment_minutes=appointment_minutes, available=available,
                                  time_off=sorted(off))
        saved = await client.request(acct, "PUT", f"/hospital/doctors/{doc['id']}", payload)
    note = ""
    if available is False and saved.get("upcoming"):
        note = f" Their {saved['upcoming']} existing upcoming appointment{'s stay' if saved['upcoming'] != 1 else ' stays'} booked."
    return f"Updated. {_doctor_line(saved)}{note}"


@mcp.tool(title="Remove doctor", annotations=DESTRUCTIVE)
async def remove_doctor(doctor: str, ctx: Context) -> str:
    """[Hospital] Remove a doctor so patients can't book them. Not allowed while they have upcoming appointments
    (mark them unavailable instead). Always confirm with the user first."""
    with friendly_errors():
        acct = await _account(ctx, "hospital")
        place = acct.hospital["name"] if acct.hospital else "This hospital"
        doc = _pick_doctor(await _my_doctors(acct), doctor, place)
        res = await client.request(acct, "DELETE", f"/hospital/doctors/{doc['id']}")
    kept = " Their past appointment history is kept." if res.get("archived") else ""
    return f"Removed {doc['name']}.{kept}"


# ---------------------------------------------------------------------------
# Prompts: one-click starting points in Claude
# ---------------------------------------------------------------------------
@mcp.prompt(title="Start with IRA")
def start_ira() -> str:
    """Begin an IRA session as the connected account."""
    return ("Check who I'm logged in as in IRA, then in one or two short sentences tell me what's coming "
            "up for me today and what you can help with.")


# ---------------------------------------------------------------------------
# ASGI app (Vercel / uvicorn)
# ---------------------------------------------------------------------------
def _inner_app():
    return mcp.streamable_http_app(
        streamable_http_path="/mcp",
        stateless_http=True,
        json_response=True,
        # Host checks are for localhost DNS-rebinding; on Vercel the Host is the public domain.
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )


async def app(scope, receive, send):
    """Serverless-friendly ASGI entry point.

    The SDK's app starts its session manager in a lifespan hook, which serverless runtimes may
    never call, and a manager can only start once. So each request gets a fresh, cheap app whose
    lifespan runs around that single request.
    """
    if scope["type"] == "lifespan":
        while True:
            message = await receive()
            if message["type"] == "lifespan.startup":
                await send({"type": "lifespan.startup.complete"})
            elif message["type"] == "lifespan.shutdown":
                await send({"type": "lifespan.shutdown.complete"})
                return
    inner = _inner_app()
    async with inner.router.lifespan_context(inner):
        await inner(scope, receive, send)
