"""Thin async client for the ROSE Cloudflare Worker backend."""

from __future__ import annotations

from dataclasses import dataclass

import aiohttp

from .const import DEFAULT_TIMEOUT


class RoseApiError(Exception):
    """Raised when the ROSE backend returns an error or is unreachable."""


class RoseAuthError(RoseApiError):
    """Raised when the ROSE backend rejects the configured API key."""


@dataclass
class RoseChatResponse:
    """A single chat reply from ROSE."""

    conversation_id: str
    reply: str
    memories_used: int = 0


class RoseApiClient:
    """Talks to a ROSE Worker deployment over its HTTP API."""

    def __init__(self, session: aiohttp.ClientSession, url: str, api_key: str) -> None:
        self._session = session
        self._url = url.rstrip("/")
        self._api_key = api_key

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }

    async def async_health_check(self) -> bool:
        """Return True if the Worker is reachable and healthy."""
        try:
            async with self._session.get(
                f"{self._url}/health", timeout=aiohttp.ClientTimeout(total=DEFAULT_TIMEOUT)
            ) as resp:
                return resp.status == 200
        except aiohttp.ClientError as err:
            raise RoseApiError(f"Could not reach ROSE at {self._url}: {err}") from err

    async def async_chat(
        self, text: str, conversation_id: str | None = None, remember: bool = False
    ) -> RoseChatResponse:
        """Send a message to ROSE and return its reply."""
        payload = {"text": text, "remember": remember}
        if conversation_id:
            payload["conversation_id"] = conversation_id

        try:
            async with self._session.post(
                f"{self._url}/chat",
                headers=self._headers(),
                json=payload,
                timeout=aiohttp.ClientTimeout(total=DEFAULT_TIMEOUT),
            ) as resp:
                if resp.status == 401:
                    raise RoseAuthError("ROSE rejected the configured API key")
                if resp.status != 200:
                    body = await resp.text()
                    raise RoseApiError(f"ROSE returned {resp.status}: {body}")
                data = await resp.json()
        except aiohttp.ClientError as err:
            raise RoseApiError(f"Could not reach ROSE at {self._url}: {err}") from err

        return RoseChatResponse(
            conversation_id=data["conversation_id"],
            reply=data["reply"],
            memories_used=data.get("memories_used", 0),
        )
