# Vercel Python function: the ERA MCP server (Streamable HTTP, OAuth-protected).
# Served at /mcp and /.well-known/oauth-protected-resource/* via rewrites in vercel.json.
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "mcp", "src"))

from era_mcp.server import app as _mcp_app  # noqa: E402

_PRM = "/.well-known/oauth-protected-resource/mcp"


async def app(scope, receive, send):
    # Depending on how the rewrite is delivered, the path may be the public one or /api/mcp.
    if scope.get("type") == "http" and scope.get("path", "").startswith("/api/mcp"):
        query = scope.get("query_string", b"")
        path = _PRM if b"__prm=1" in query else "/mcp"
        scope = {**scope, "path": path, "raw_path": path.encode()}
    await _mcp_app(scope, receive, send)
