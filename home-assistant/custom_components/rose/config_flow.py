"""Config flow for ROSE."""

from __future__ import annotations

from typing import Any

import aiohttp
import voluptuous as vol
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import RoseApiClient, RoseApiError, RoseAuthError
from .const import CONF_API_KEY, CONF_URL, DEFAULT_NAME, DOMAIN

STEP_USER_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_URL): str,
        vol.Required(CONF_API_KEY): str,
    }
)


class RoseConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for ROSE."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Handle the initial step: ask for the Worker URL and API key."""
        errors: dict[str, str] = {}

        if user_input is not None:
            self._async_abort_entries_match({CONF_URL: user_input[CONF_URL]})

            session = async_get_clientsession(self.hass)
            client = RoseApiClient(session, user_input[CONF_URL], user_input[CONF_API_KEY])

            try:
                healthy = await client.async_health_check()
            except RoseAuthError:
                errors["base"] = "invalid_auth"
            except RoseApiError:
                errors["base"] = "cannot_connect"
            except aiohttp.ClientError:
                errors["base"] = "cannot_connect"
            else:
                if not healthy:
                    errors["base"] = "cannot_connect"

            if not errors:
                return self.async_create_entry(title=DEFAULT_NAME, data=user_input)

        return self.async_show_form(
            step_id="user", data_schema=STEP_USER_SCHEMA, errors=errors
        )
