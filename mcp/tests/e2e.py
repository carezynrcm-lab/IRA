"""End-to-end check of the OAuth-protected MCP server, acting like Claude's custom connector.

    uv run python tests/e2e.py [MCP_URL]        # default http://127.0.0.1:8765/mcp

1. Calls the MCP endpoint without a token and follows the 401 to the OAuth metadata.
2. Registers a client, logs in on IRA's authorize page (as a hospital, then a patient),
   exchanges the code with PKCE, and connects with the bearer token.
3. Checks each role sees only its own tools, and runs real operations.
Needs the IRA site running with the demo accounts.
"""

import asyncio
import base64
import hashlib
import re
import secrets
import sys
from urllib.parse import parse_qs, urlparse

import httpx
from mcp.client import Client
from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client

MCP_URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/mcp"
REDIRECT = "https://claude.ai/api/mcp/auth_callback"
created: list[int] = []


async def discover(http: httpx.AsyncClient) -> dict:
    r = await http.post(MCP_URL, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                        headers={"Accept": "application/json, text/event-stream"})
    assert r.status_code == 401, r.status_code
    www = r.headers["www-authenticate"]
    print("✓ no token → 401;", www[:110])
    prm_url = re.search(r'resource_metadata="([^"]+)"', www).group(1)
    prm = (await http.get(prm_url)).json()
    print("✓ protected resource metadata:", prm)
    issuer = str(prm["authorization_servers"][0]).rstrip("/")
    asm = (await http.get(f"{issuer}/.well-known/oauth-authorization-server")).json()
    print("✓ authorization server:", asm["issuer"])
    return asm


async def oauth_login(http: httpx.AsyncClient, asm: dict, role: str, email: str, password: str) -> str:
    reg = (await http.post(asm["registration_endpoint"], json={
        "client_name": "Claude (e2e)", "redirect_uris": [REDIRECT], "token_endpoint_auth_method": "none"})).json()
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    params = {"response_type": "code", "client_id": reg["client_id"], "redirect_uri": REDIRECT,
              "code_challenge": challenge, "code_challenge_method": "S256", "state": "s1", "scope": "ira",
              "resource": MCP_URL}
    page = await http.get(asm["authorization_endpoint"], params=params)
    assert page.status_code == 200 and "Log in to IRA" in page.text
    r = await http.post(asm["authorization_endpoint"], data={**params, "role": role, "email": email,
                                                             "password": password, "decision": "allow"})
    assert r.status_code == 302, (r.status_code, r.text[:200])
    q = parse_qs(urlparse(r.headers["location"]).query)
    assert q["state"] == ["s1"]
    tok = (await http.post(asm["token_endpoint"], data={
        "grant_type": "authorization_code", "code": q["code"][0], "client_id": reg["client_id"],
        "redirect_uri": REDIRECT, "code_verifier": verifier})).json()
    print(f"✓ OAuth login as {role} ({email}) → {tok['token_type']} token, expires in {tok['expires_in'] // 86400} days")
    return tok["access_token"]


async def session(token: str, label: str, script) -> None:
    http = create_mcp_http_client(headers={"Authorization": f"Bearer {token}"})
    async with Client(streamable_http_client(MCP_URL, http_client=http)) as c:
        names = sorted(t.name for t in (await c.list_tools()).tools)
        print(f"\n◆ {label} sees {len(names)} tools: {', '.join(names)}\n")

        async def call(tool, **args):
            r = await c.call_tool(tool, args)
            text = "\n".join(getattr(b, "text", "") for b in r.content)
            print(f"▶ {tool}({', '.join(f'{k}={v!r}' for k, v in args.items())})\n{'ERROR ' if r.is_error else ''}{text}\n")
            return r.is_error, text

        await script(set(names), call)


async def hospital_script(names, call):
    assert "get_schedule" in names and "book_appointment" not in names
    await call("whoami")
    await call("hospital_summary")
    await call("get_schedule", date="friday")
    await call("list_patients", search="priya")
    err, _ = await call("book_appointment", hospital="City General", date="tomorrow", time="10am")
    assert err


async def patient_script(names, call):
    assert "book_appointment" in names and "get_schedule" not in names
    await call("whoami")
    await call("find_next_available", hospital="lotus", part_of_day="morning", how_many=3)
    err, booked = await call("book_appointment", hospital="City General", date="friday", time="2:30 pm", reason="E2E TEST")
    if not err:
        aid = int(booked.rsplit("appointment id ", 1)[1].rstrip("]"))
        created.append(aid)
        await call("reschedule_appointment", appointment_id=aid, new_date="friday", new_time="3 pm")
        await call("cancel_appointment", appointment_id=aid)
    err, _ = await call("get_schedule", date="today")
    assert err


async def main() -> None:
    async with httpx.AsyncClient(timeout=30, follow_redirects=False) as http:
        asm = await discover(http)
        hosp = await oauth_login(http, asm, "hospital", "city@demo.com", "hospital123")
        pat = await oauth_login(http, asm, "patient", "patient@demo.com", "patient123")
        bad = await http.post(MCP_URL, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                              headers={"Authorization": "Bearer not-a-real-token", "Accept": "application/json, text/event-stream"})
        assert bad.status_code == 401
        print("✓ invalid token → 401")
    await session(hosp, "Hospital (City General)", hospital_script)
    await session(pat, "Patient (Aarav)", patient_script)
    print("created appointment ids (cancelled):", created)
    print("ALL CHECKS PASSED")


if __name__ == "__main__":
    asyncio.run(main())
