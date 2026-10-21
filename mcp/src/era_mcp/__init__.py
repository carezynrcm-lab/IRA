"""ERA MCP server (Streamable HTTP, OAuth-protected).

    era-mcp                      # http://127.0.0.1:8765/mcp
    era-mcp --port 9000

In production it runs on Vercel (see api/mcp.py); this command is for local development.
Settings come from the environment: ERA_URL (the ERA site, also the OAuth issuer)
and MCP_PUBLIC_URL (this endpoint's public URL).
"""

from __future__ import annotations

import argparse
import os
import sys


def main() -> None:
    parser = argparse.ArgumentParser(prog="era-mcp", description="MCP server for the ERA appointment system")
    parser.add_argument("--host", default=os.environ.get("MCP_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("MCP_PORT", "8765")))
    parser.add_argument("--era-url", help="ERA base URL (default $ERA_URL or http://localhost:3000)")
    args = parser.parse_args()

    if args.era_url:
        os.environ["ERA_URL"] = args.era_url
    os.environ.setdefault("MCP_PUBLIC_URL", f"http://localhost:{args.port}/mcp")

    import uvicorn

    print(f"ERA MCP on http://{args.host}:{args.port}/mcp (auth via {os.environ.get('ERA_URL', 'http://localhost:3000')})",
          file=sys.stderr)
    uvicorn.run("era_mcp.server:app", host=args.host, port=args.port, log_level="warning")
