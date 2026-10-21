"""Async client for the ERA REST API and the per-connection login state."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx


class ERAError(Exception):
    """An error with a message that is safe and useful to show (or say) to the user."""


@dataclass
class Account:
    token: str | None = None
    user: dict[str, Any] | None = None
    hospital: dict[str, Any] | None = None

    @property
    def role(self) -> str | None:
        return self.user["role"] if self.user else None


class ERAClient:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")
        self._http = httpx.AsyncClient(base_url=f"{self.base_url}/api", timeout=15.0)

    async def request(self, account: Account | None, method: str, path: str, body: Any = None) -> Any:
        headers = {"Authorization": f"Bearer {account.token}"} if account and account.token else {}
        try:
            res = await self._http.request(method, path, json=body, headers=headers)
        except httpx.HTTPError as exc:
            raise ERAError(
                f"I can't reach the ERA server at {self.base_url}. Is it running? ({exc.__class__.__name__})"
            ) from exc

        # Sessions last 30 days. Passwords are never stored, so ask the user to log in again.
        if res.status_code == 401 and account and account.token and not path.startswith("/auth/"):
            account.token = account.user = account.hospital = None
            raise ERAError("The login session has expired. Please log in again.")

        data = None if res.status_code == 204 else _json(res)
        if res.is_error:
            message = data.get("error") if isinstance(data, dict) else None
            raise ERAError(message or f"ERA returned an error ({res.status_code}).")
        return data

    async def sign_in(self, account: Account, email: str, password: str) -> Account:
        data = await self.request(None, "POST", "/auth/login", {"email": email, "password": password})
        account.token = data["token"]
        account.user = data["user"]
        account.hospital = data.get("hospital")
        return account

    async def sign_out(self, account: Account) -> None:
        if account.token:
            try:
                await self.request(account, "POST", "/auth/logout")
            except ERAError:
                pass
        account.token = account.user = account.hospital = None

    async def aclose(self) -> None:
        await self._http.aclose()


def _json(res: httpx.Response) -> Any:
    try:
        return res.json()
    except ValueError:
        return None
