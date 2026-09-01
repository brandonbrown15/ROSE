"""The ROSE integration — a persistent, memory-backed AI assistant."""

from __future__ import annotations

from dataclasses import dataclass

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import RoseApiClient, RoseApiError
from .const import CONF_API_KEY, CONF_URL, DOMAIN
from .wake_word import async_setup_wake_word

PLATFORMS: list[Platform] = [Platform.CONVERSATION]


@dataclass
class RoseData:
    """Runtime data attached to a ROSE config entry."""

    client: RoseApiClient


RoseConfigEntry = ConfigEntry[RoseData]


async def async_setup_entry(hass: HomeAssistant, entry: RoseConfigEntry) -> bool:
    """Set up ROSE from a config entry."""
    session = async_get_clientsession(hass)
    client = RoseApiClient(session, entry.data[CONF_URL], entry.data[CONF_API_KEY])

    try:
        if not await client.async_health_check():
            return False
    except RoseApiError as err:
        raise err

    entry.runtime_data = RoseData(client=client)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    # Best-effort, non-blocking: install the bundled "Rose" wake-word model
    # and, if unambiguous, select it. Never affects entry setup succeeding.
    hass.async_create_task(
        async_setup_wake_word(hass, entry), "rose_wake_word_setup"
    )

    return True


async def async_unload_entry(hass: HomeAssistant, entry: RoseConfigEntry) -> bool:
    """Unload a ROSE config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
