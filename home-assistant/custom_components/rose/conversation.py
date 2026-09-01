"""The ROSE conversation agent."""

from __future__ import annotations

from homeassistant.components import conversation
from homeassistant.components.conversation import ConversationEntity, ConversationEntityFeature
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import MATCH_ALL
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import RoseConfigEntry
from .api import RoseApiError
from .const import DEFAULT_NAME, DOMAIN


async def async_setup_entry(
    hass: HomeAssistant,
    entry: RoseConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the ROSE conversation entity."""
    async_add_entities([RoseConversationEntity(entry)])


class RoseConversationEntity(ConversationEntity):
    """Registers ROSE as a Home Assistant conversation agent (`conversation.rose`)."""

    _attr_has_entity_name = True
    _attr_name = None
    _attr_supported_features = ConversationEntityFeature.CONTROL

    def __init__(self, entry: RoseConfigEntry) -> None:
        self.entry = entry
        self._attr_unique_id = entry.entry_id
        self._attr_device_info = {
            "identifiers": {(DOMAIN, entry.entry_id)},
            "name": DEFAULT_NAME,
            "manufacturer": "ROSE",
        }

    @property
    def supported_languages(self) -> list[str] | str:
        """ROSE relies on the underlying model's language support."""
        return MATCH_ALL

    async def async_process(
        self, user_input: conversation.ConversationInput
    ) -> conversation.ConversationResult:
        """Send the user's utterance to the ROSE backend and return its reply."""
        client = self.entry.runtime_data.client
        response = conversation.IntentResponse(language=user_input.language)

        try:
            result = await client.async_chat(
                user_input.text, conversation_id=user_input.conversation_id
            )
        except RoseApiError as err:
            response.async_set_error(
                conversation.intent.IntentResponseErrorCode.UNKNOWN,
                f"ROSE couldn't process that: {err}",
            )
            return conversation.ConversationResult(
                response=response, conversation_id=user_input.conversation_id
            )

        response.async_set_speech(result.reply)
        return conversation.ConversationResult(
            response=response, conversation_id=result.conversation_id
        )
