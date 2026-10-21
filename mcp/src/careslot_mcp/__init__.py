"""CareSlot MCP server (Streamable HTTP, OAuth-protected).

    careslot-mcp                      # http://127.0.0.1:8765/mcp
    careslot-mcp --port 9000

In production it runs on Vercel (see api/mcp.py); this command is for local development.
Settings come from the environment: CARESLOT_URL (the CareSlot site, also the OAuth issuer)
and MCP_PUBLIC_URL (this endpoint's public URL).
"""

from __future__ import annotations

import argparse
import os
import sys


def main() -> None:
    parser = argparse.ArgumentParser(prog="careslot-mcp", description="MCP server for the CareSlot appointment system")
    parser.add_argument("--host", default=os.environ.get("MCP_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("MCP_PORT", "8765")))
    parser.add_argument("--careslot-url", help="CareSlot base URL (default $CARESLOT_URL or http://localhost:3000)")
    args = parser.parse_args()

    if args.careslot_url:
        os.environ["CARESLOT_URL"] = args.careslot_url
    os.environ.setdefault("MCP_PUBLIC_URL", f"http://localhost:{args.port}/mcp")

    import uvicorn

    print(f"CareSlot MCP on http://{args.host}:{args.port}/mcp (auth via {os.environ.get('CARESLOT_URL', 'http://localhost:3000')})",
          file=sys.stderr)
    uvicorn.run("careslot_mcp.server:app", host=args.host, port=args.port, log_level="warning")
