"""CareSlot MCP server: lets an assistant act as a patient or as a hospital.

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

from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.provider import AccessToken, TokenVerifier
from mcp.server.auth.settings import AuthSettings
from mcp.server.context import CallNext, HandlerResult, ServerMiddleware, ServerRequestContext
from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp_types import CallToolResult, TextContent, ToolAnnotations

from .api import Account, CareSlotClient, CareSlotError
from .dates import (WEEKDAYS, fmt_date, fmt_time, in_part_of_day, now_hhmm, on_date, parse_date, parse_time, today)

INSTRUCTIONS = """\
CareSlot is a hospital appointment booking system used by PATIENTS and HOSPITALS (doctors).

The user logged in when they connected this connector (CareSlot's OAuth login page, where they
chose patient or hospital), so you act as that account and see only its tools. Call `whoami` to
see who that is, plus today's date and time.
- A patient can find hospitals, check free slots, book, reschedule, cancel and review appointments.
- A hospital can see the schedule for any date, appointment records, patients and their history,
  mark visits completed, cancel, and change working hours.
To act as a different account, the user disconnects and reconnects the connector (or adds a
second connector) and logs in as the other account.

Working style:
- Pass dates and times exactly as the user says them ("tomorrow", "next Friday", "23 Oct",
  "3:30 pm"); the tools resolve them. Hospitals can be named loosely ("City General").
- The user may be speaking through voice. Keep replies short and natural to say out loud,
  say times like "9:30 AM", and don't read IDs aloud unless needed.
- Always confirm with the user before booking, rescheduling, cancelling, or changing hours.
"""

PartOfDay = Literal["any", "morning", "afternoon", "evening"]
DOW_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
# CareSlot stores working days as JS weekday numbers (0 = Sunday).
JS_TO_PY = {0: 6, 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5}
PY_TO_JS = {v: k for k, v in JS_TO_PY.items()}

READ = ToolAnnotations(read_only_hint=True, open_world_hint=False)
WRITE = ToolAnnotations(read_only_hint=False, destructive_hint=False, open_world_hint=False)
DESTRUCTIVE = ToolAnnotations(read_only_hint=False, destructive_hint=True, open_world_hint=False)

# Which tools each kind of account can see and use.
COMMON_TOOLS = {"whoami", "notifications", "update_my_profile", "cancel_appointment"}
ROLE_TOOLS = {
    "patient": COMMON_TOOLS | {
        "list_hospitals", "get_hospital", "check_availability", "find_next_available",
        "book_appointment", "my_appointments", "reschedule_appointment",
    },
    "hospital": COMMON_TOOLS | {
        "hospital_summary", "get_schedule", "get_appointments", "complete_appointment",
        "list_patients", "patient_history", "get_working_hours", "update_working_hours",
    },
}

CARESLOT_URL = os.environ.get("CARESLOT_URL", "http://localhost:3000").rstrip("/")
# Public URL of this MCP endpoint (the OAuth "resource"), e.g. https://careslot.vercel.app/mcp.
MCP_PUBLIC_URL = os.environ.get("MCP_PUBLIC_URL", "http://localhost:8765/mcp").rstrip("/")

client = CareSlotClient(CARESLOT_URL)


# ---------------------------------------------------------------------------
# OAuth: every request carries a CareSlot access token (issued by CareSlot's own login page).
# ---------------------------------------------------------------------------
class CareSlotTokenVerifier(TokenVerifier):
    """Verifies bearer tokens by asking CareSlot who they belong to (cached briefly)."""

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
        except CareSlotError:
            me = None
        result = None
        if me and me["user"]["role"] in ROLE_TOOLS:
            result = AccessToken(
                token=token, client_id="careslot", scopes=["careslot"], resource=MCP_PUBLIC_URL,
                subject=str(me["user"]["id"]), claims={"user": me["user"], "hospital": me.get("hospital")},
            )
        if len(self._cache) > 5000:
            self._cache.clear()
        self._cache[key] = (time.monotonic() + self.TTL, result)
        return result


def _token_key(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


verifier = CareSlotTokenVerifier()


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
                msg = (f"“{name}” isn't available to {who}. To use another account, reconnect the CareSlot "
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
    name="careslot",
    title="CareSlot Appointments",
    description="Book and manage hospital appointments as a patient or a hospital.",
    instructions=INSTRUCTIONS,
    version="2.0.0",
    log_level=os.environ.get("CARESLOT_MCP_LOG_LEVEL", "WARNING"),
    token_verifier=verifier,
    auth=AuthSettings(
        issuer_url=CARESLOT_URL,
        resource_server_url=MCP_PUBLIC_URL,
        required_scopes=["careslot"],
        validate_token_resource=False,  # tokens are CareSlot sessions; the verifier checks them itself
    ),
    middleware=[RoleGate()],
)
logging.getLogger("httpx").setLevel(logging.WARNING)


async def _account(ctx: Context, role: str | None = None) -> Account:
    acct = _current_account()
    if not acct:
        raise ToolError("You're not logged in. Reconnect the CareSlot connector to log in.")
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
    except (CareSlotError, ValueError) as exc:
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


async def _free_slots(acct: Account, h: dict, d: date, part: str | None = None) -> tuple[bool, list[str]]:
    data = await _get(acct, f"/hospitals/{h['id']}/slots?date={d.isoformat()}")
    free = [s["time"] for s in data["slots"] if s["status"] == "free" and in_part_of_day(s["time"], part)]
    return data["open"], free


def _patient_appt_line(a: dict) -> str:
    line = f"{fmt_date(a['date'])} at {fmt_time(a['time'])}, {a['hospital_name']} — {a['status']}"
    if a.get("reason"):
        line += f", reason: {a['reason']}"
    return f"{line} [appointment id {a['id']}]"


def _hospital_appt_line(a: dict, with_date: bool = False) -> str:
    when = f"{fmt_date(a['date'])} " if with_date else ""
    line = f"{when}{fmt_time(a['time'])} — {a['patient_name']} ({a['status']})"
    if a.get("reason"):
        line += f", reason: {a['reason']}"
    if a.get("patient_phone"):
        line += f", phone {a['patient_phone']}"
    return f"{line} [appointment id {a['id']}]"


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
    """Show which CareSlot account you're acting as, plus today's date and the current time."""
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
    """[Patient] List hospitals, optionally filtered by name, city or specialty (e.g. "cardiology", "Pune")."""
    with friendly_errors():
        acct = await _account(ctx)
        hospitals = await _get(acct, "/hospitals")
    if search:
        words = _norm(search).split()
        hospitals = [h for h in hospitals if all(w in _norm(f"{h['name']} {h['city']} {h['specialties']}") for w in words)]
    if not hospitals:
        return f"No hospitals match “{search}”."
    lines = [
        f"- {h['name']} in {h['city']} — {h['specialties'] or 'general care'}. Open {_hours(h)}"
        f"{' (open now)' if _is_open_now(h) else ''}. [hospital id {h['id']}]"
        for h in hospitals
    ]
    return f"{len(hospitals)} hospital{'s' if len(hospitals) != 1 else ''}:\n" + "\n".join(lines)


@mcp.tool(title="Hospital details", annotations=READ)
async def get_hospital(hospital: str, ctx: Context) -> str:
    """[Patient] Details for one hospital: address, phone, specialties, working hours and slot length."""
    with friendly_errors():
        acct = await _account(ctx)
        h = await _resolve_hospital(acct, hospital)
    return (
        f"{h['name']}, {h['address'] or h['city']}. Phone {h['phone'] or 'not listed'}. "
        f"Specialties: {h['specialties'] or 'general care'}. Open {_hours(h)}, "
        f"{h['slot_minutes']}-minute appointments. It is {'open' if _is_open_now(h) else 'closed'} right now. "
        f"[hospital id {h['id']}]"
    )


@mcp.tool(title="Check availability", annotations=READ)
async def check_availability(hospital: str, ctx: Context, date: str = "today", part_of_day: PartOfDay = "any") -> str:
    """[Patient] Free appointment times at a hospital on one date.

    `date` can be natural ("tomorrow", "Friday", "23 Oct"). `part_of_day` narrows to morning/afternoon/evening.
    """
    with friendly_errors():
        acct = await _account(ctx)
        h = await _resolve_hospital(acct, hospital)
        d = parse_date(date)
        if d < today():
            raise ToolError(f"{fmt_date(d)} is in the past. Pick today or a later date.")
        is_open, free = await _free_slots(acct, h, d, part_of_day)
    when = on_date(d)
    if not is_open:
        nxt = next((d + timedelta(days=i) for i in range(1, 15) if _is_open_on(h, d + timedelta(days=i))), None)
        tail = f" The next open day is {fmt_date(nxt)}." if nxt else ""
        return f"{h['name']} is closed {when}. It's open {_hours(h)}.{tail}"
    part = "" if part_of_day == "any" else f" in the {part_of_day}"
    if not free:
        return f"No free slots at {h['name']}{part} {when}. Try find_next_available for the next opening."
    listing = _slot_list(free) if part_of_day != "any" else _group_by_part(free)
    return f"{h['name']} has {len(free)} free slot{'s' if len(free) != 1 else ''}{part} {when}: {listing}."


@mcp.tool(title="Find next available", annotations=READ)
async def find_next_available(
    hospital: str, ctx: Context, starting: str = "today", part_of_day: PartOfDay = "any", how_many: int = 5,
) -> str:
    """[Patient] The earliest free appointment times at a hospital, searching up to 3 weeks ahead.

    Great for "when's the next free slot at City General?" or "earliest morning slot next week".
    """
    with friendly_errors():
        acct = await _account(ctx)
        h = await _resolve_hospital(acct, hospital)
        start = max(parse_date(starting), today())
        found: list[tuple[date, str]] = []
        for i in range(21):
            d = start + timedelta(days=i)
            if not _is_open_on(h, d):
                continue
            _, free = await _free_slots(acct, h, d, part_of_day)
            found.extend((d, t) for t in free)
            if len(found) >= how_many:
                break
    if not found:
        return f"No free slots at {h['name']} in the next three weeks."
    found = found[: max(1, min(how_many, 20))]
    by_day: dict[date, list[str]] = {}
    for d, t in found:
        by_day.setdefault(d, []).append(t)
    first_d, first_t = found[0]
    rest = "; ".join(f"{fmt_date(d)}: {_slot_list(ts)}" for d, ts in by_day.items())
    return f"The earliest free slot at {h['name']} is {fmt_date(first_d)} at {fmt_time(first_t)}. Options — {rest}."


@mcp.tool(title="Book appointment", annotations=WRITE)
async def book_appointment(hospital: str, date: str, time: str, ctx: Context, reason: str = "") -> str:
    """[Patient] Book an appointment. Confirm the hospital, date and time with the user first.

    `date` and `time` can be natural ("tomorrow", "10:30 am").
    """
    with friendly_errors():
        acct = await _account(ctx, "patient")
        h = await _resolve_hospital(acct, hospital)
        d, t = parse_date(date), parse_time(time)
        try:
            a = await client.request(acct, "POST", "/appointments",
                                     {"hospitalId": h["id"], "date": d.isoformat(), "time": t, "reason": reason})
        except CareSlotError as exc:
            # Offer nearby alternatives so the conversation can continue smoothly.
            hint = ""
            if _is_open_on(h, d) and d >= today():
                _, free = await _free_slots(acct, h, d)
                if free:
                    nearest = sorted(free, key=lambda x: abs(int(x[:2]) * 60 + int(x[3:]) - int(t[:2]) * 60 - int(t[3:])))[:4]
                    hint = f" Free times that day include {_slot_list(sorted(nearest))}."
            raise ToolError(f"Couldn't book: {str(exc).rstrip('.')}.{hint}") from exc
    return (
        f"Booked! {h['name']} {on_date(a['date'])} at {fmt_time(a['time'])}"
        f"{f' for {reason}' if reason else ''}. A confirmation has been sent. [appointment id {a['id']}]"
    )


@mcp.tool(title="My appointments", annotations=READ)
async def my_appointments(
    ctx: Context, which: Literal["upcoming", "past", "all"] = "upcoming", hospital: str | None = None,
) -> str:
    """[Patient] List the patient's appointments: upcoming (default), past (history incl. cancelled), or all."""
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
    """[Patient] Move one of the patient's booked appointments to a new date and time at the same hospital."""
    with friendly_errors():
        acct = await _account(ctx, "patient")
        old = await _find_patient_appointment(acct, appointment_id)
        d, t = parse_date(new_date), parse_time(new_time)
        a = await client.request(acct, "POST", f"/appointments/{appointment_id}/reschedule", {"date": d.isoformat(), "time": t})
    return (
        f"Rescheduled. Your {a['hospital_name']} appointment moved from {fmt_date(old['date'])} at "
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
            who = a["hospital_name"]
        elif acct.role == "hospital":
            a = await _find_hospital_appointment(acct, appointment_id)
            who = a["patient_name"]
        else:
            raise ToolError("Only patient or hospital accounts can cancel appointments.")
        await client.request(acct, "PATCH", f"/appointments/{appointment_id}", {"status": "cancelled"})
    notified = "The patient has been notified." if acct.role == "hospital" else "The hospital has been notified."
    return f"Cancelled the appointment with {who} {on_date(a['date'])} at {fmt_time(a['time'])}. {notified}"


# ---------------------------------------------------------------------------
# Hospital tools
# ---------------------------------------------------------------------------
@mcp.tool(title="Hospital summary", annotations=READ)
async def hospital_summary(ctx: Context) -> str:
    """[Hospital] Quick briefing: today's appointments, who's next, and the coming week."""
    with friendly_errors():
        acct = await _account(ctx, "hospital")
        t = today()
        appts = await _hospital_appointments(acct, t, t + timedelta(days=6))
    active = [a for a in appts if a["status"] != "cancelled"]
    todays = [a for a in active if a["date"] == t.isoformat()]
    remaining = sorted([a for a in todays if a["status"] == "booked" and a["time"] >= now_hhmm()], key=lambda a: a["time"])
    done = len([a for a in todays if a["status"] == "completed"])
    name = acct.hospital["name"] if acct.hospital else "Your hospital"
    parts = [f"{name}: {len(todays)} appointment{'s' if len(todays) != 1 else ''} today, {done} completed, {len(remaining)} still to come."]
    if remaining:
        n = remaining[0]
        reason = f" for {n['reason']}" if n.get("reason") else ""
        parts.append(f"Next up is {n['patient_name']} at {fmt_time(n['time'])}{reason}.")
    per_day = {}
    for a in active:
        per_day[a["date"]] = per_day.get(a["date"], 0) + 1
    week = ", ".join(f"{fmt_date(d).split(' (')[0]} {c}" for d, c in sorted(per_day.items()) if d != t.isoformat())
    parts.append(f"Next 6 days: {len(active) - len(todays)} bookings" + (f" ({week})." if week else "."))
    return " ".join(parts)


@mcp.tool(title="Schedule for a date", annotations=READ)
async def get_schedule(ctx: Context, date: str = "today", include_cancelled: bool = False) -> str:
    """[Hospital] All appointments on one date, in time order, with patient names, reasons and phone numbers."""
    with friendly_errors():
        acct = await _account(ctx, "hospital")
        d = parse_date(date)
        appts = await _hospital_appointments(acct, d, d)
    rows = [a for a in appts if include_cancelled or a["status"] != "cancelled"]
    cancelled = len(appts) - len([a for a in appts if a["status"] != "cancelled"])
    when = on_date(d)
    note = f" ({cancelled} cancelled not shown)" if cancelled and not include_cancelled else ""
    if not rows:
        return f"No appointments {when}{note}."
    lines = "\n".join(f"- {_hospital_appt_line(a)}" for a in sorted(rows, key=lambda a: a["time"]))
    return f"{len(rows)} appointment{'s' if len(rows) != 1 else ''} {when}{note}:\n{lines}"


@mcp.tool(title="Appointments in a date range", annotations=READ)
async def get_appointments(
    ctx: Context, from_date: str = "today", to_date: str = "in 7 days",
    status: Literal["any", "booked", "completed", "cancelled"] = "any",
) -> str:
    """[Hospital] Appointment records between two dates (inclusive), grouped by day. Optionally filter by status."""
    with friendly_errors():
        acct = await _account(ctx, "hospital")
        start, end = parse_date(from_date), parse_date(to_date)
        if end < start:
            start, end = end, start
        if (end - start).days > 92:
            raise ToolError("Please ask for at most about three months at a time.")
        appts = await _hospital_appointments(acct, start, end)
    if status != "any":
        appts = [a for a in appts if a["status"] == status]
    if not appts:
        return f"No {'' if status == 'any' else status + ' '}appointments between {fmt_date(start)} and {fmt_date(end)}."
    by_day: dict[str, list[dict]] = {}
    for a in appts:
        by_day.setdefault(a["date"], []).append(a)
    out = [f"{len(appts)} appointment{'s' if len(appts) != 1 else ''} from {fmt_date(start)} to {fmt_date(end)}:"]
    for d, rows in sorted(by_day.items()):
        out.append(f"{fmt_date(d)} — {len(rows)}:")
        out.extend(f"  - {_hospital_appt_line(a)}" for a in sorted(rows, key=lambda a: a["time"])[:15])
    return "\n".join(out[:120])


@mcp.tool(title="Mark appointment completed", annotations=WRITE)
async def complete_appointment(appointment_id: int, ctx: Context) -> str:
    """[Hospital] Mark a booked appointment as completed (the patient was seen)."""
    with friendly_errors():
        acct = await _account(ctx, "hospital")
        a = await _find_hospital_appointment(acct, appointment_id)
        await client.request(acct, "PATCH", f"/appointments/{appointment_id}", {"status": "completed"})
    return f"Marked {a['patient_name']}'s appointment {on_date(a['date'])} at {fmt_time(a['time'])} as completed."


@mcp.tool(title="List patients", annotations=READ)
async def list_patients(ctx: Context, search: str | None = None) -> str:
    """[Hospital] Patients who have booked with this hospital, with visit counts. Optionally search by name, email or phone."""
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
        f"last on {fmt_date(p['last_date'])}. Phone {p['phone'] or 'n/a'}, email {p['email']}. [patient id {p['id']}]"
        for p in patients[:40]
    ]
    return f"{len(patients)} patient{'s' if len(patients) != 1 else ''}:\n" + "\n".join(lines)


@mcp.tool(title="Patient history", annotations=READ)
async def patient_history(patient: str, ctx: Context) -> str:
    """[Hospital] One patient's appointment history at this hospital (past and upcoming). `patient` is a name, email or patient id."""
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


@mcp.tool(title="Working hours", annotations=READ)
async def get_working_hours(ctx: Context) -> str:
    """[Hospital] The hospital's current working days, hours and appointment length."""
    with friendly_errors():
        acct = await _account(ctx, "hospital")
        h = await _get(acct, "/hospital/settings")
    return f"{h['name']} is open {_hours(h)}, with {h['slot_minutes']}-minute appointments."


@mcp.tool(title="Update working hours", annotations=WRITE)
async def update_working_hours(
    ctx: Context, open_time: str | None = None, close_time: str | None = None,
    slot_minutes: Literal[10, 15, 20, 30, 45, 60] | None = None, working_days: str | None = None,
) -> str:
    """[Hospital] Change opening/closing time, appointment length, and/or working days. Confirm with the user first.

    Only the fields you pass change. `working_days` accepts phrases like "Mon-Sat", "weekdays", "Mon, Wed, Fri".
    """
    with friendly_errors():
        acct = await _account(ctx, "hospital")
        h = await _get(acct, "/hospital/settings")
        days = _parse_days(working_days) if working_days else _open_days(h)
        payload = {
            "open_time": parse_time(open_time) if open_time else h["open_time"],
            "close_time": parse_time(close_time) if close_time else h["close_time"],
            "slot_minutes": slot_minutes or h["slot_minutes"],
            "days_open": [PY_TO_JS[d] for d in days],
            "phone": h["phone"], "address": h["address"], "specialties": h["specialties"],
        }
        saved = await client.request(acct, "PUT", "/hospital/settings", payload)
        verifier.forget(acct.token)
    return f"Updated. {saved['name']} is now open {_hours(saved)}, with {saved['slot_minutes']}-minute appointments."


# ---------------------------------------------------------------------------
# Prompts: one-click starting points in Claude
# ---------------------------------------------------------------------------
@mcp.prompt(title="Start with CareSlot")
def start_careslot() -> str:
    """Begin a CareSlot session as the connected account."""
    return ("Check who I'm logged in as in CareSlot, then in one or two short sentences tell me what's coming "
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
