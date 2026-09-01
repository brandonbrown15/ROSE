"""Best-effort automatic setup for the bundled "Rose" wake-word model.

Two independent, entirely optional steps — neither is required for ROSE
itself (the conversation agent) to work, and neither can break it:

  1. Copy the bundled model into openWakeWord's shared custom-model folder
     (``/share/openwakeword``), if this is a Home Assistant OS/Supervised
     install that has one. No-ops (logs and returns) on Core/Container
     installs, which don't have that shared volume.
  2. If exactly one wake-word provider entity exists, and an Assist
     pipeline is using this ROSE config entry as its conversation agent
     with no wake word already configured, select "Rose" as that
     pipeline's wake word. Deliberately never overwrites a wake word
     someone already chose, and never guesses between multiple wake-word
     providers or multiple candidate pipelines — those cases fall back to
     a notification pointing at manual setup instead.

Everything here is best-effort: `assist_pipeline`'s pipeline-update API
isn't part of Home Assistant's stable public interface the way
`entity_registry` is, so behavior is allowed to vary or no-op across HA
versions — this must never raise out of config entry setup. Whatever
happens (or doesn't), a persistent notification tells the user the actual
outcome so it's never a silent guess.
"""

from __future__ import annotations

import inspect
import logging
import shutil
from pathlib import Path
from typing import TYPE_CHECKING

from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er

from .const import DOMAIN

if TYPE_CHECKING:
    from . import RoseConfigEntry

_LOGGER = logging.getLogger(__name__)

_SHARE_DIR = Path("/share/openwakeword")
_BUNDLED_MODEL_DIR = Path(__file__).parent / "wake_word_model"
_WAKE_WORD_ID = "rose"
_DOC_URL = "https://github.com/brandonbrown15/rose/blob/main/docs/wake-word.md"
_NOTIFICATION_ID = f"{DOMAIN}_wake_word_setup"


async def async_setup_wake_word(hass: HomeAssistant, entry: RoseConfigEntry) -> None:
    """Install the bundled model and, if it's unambiguous and safe, select it.

    Never raises — this is a nicety layered on top of ROSE's actual job
    (being a conversation agent), not a prerequisite for it.
    """
    try:
        await _run(hass, entry)
    except Exception:  # noqa: BLE001 - must never break config entry setup
        _LOGGER.exception(
            "Automatic wake-word setup hit an unexpected error; install "
            "manually instead — see %s",
            _DOC_URL,
        )


async def _run(hass: HomeAssistant, entry: RoseConfigEntry) -> None:
    installed = await hass.async_add_executor_job(_copy_model_files)

    if not installed:
        _LOGGER.info(
            "No /share folder found (not a Home Assistant OS/Supervised "
            "install) — skipping automatic wake-word model install. See "
            "%s to install the 'Rose' wake word manually.",
            _DOC_URL,
        )
        return

    outcome = await _configure_pipeline(hass, entry)
    _notify(hass, outcome)


def _copy_model_files() -> bool:
    """Copy the bundled model into /share/openwakeword.

    Returns False if /share doesn't exist at all (not a Supervised/HAOS
    install) — this function does blocking file I/O and must only be
    called via the executor.
    """
    if not Path("/share").is_dir():
        return False
    _SHARE_DIR.mkdir(parents=True, exist_ok=True)
    for fname in ("rose.tflite", "rose.json"):
        src = _BUNDLED_MODEL_DIR / fname
        dst = _SHARE_DIR / fname
        if not dst.exists() or dst.stat().st_mtime < src.stat().st_mtime:
            shutil.copyfile(src, dst)
    return True


async def _configure_pipeline(hass: HomeAssistant, entry: RoseConfigEntry) -> str:
    """Try to select "Rose" on any pipeline using ROSE with no wake word set.

    Returns a human-readable outcome for the notification — this always
    describes what actually happened (or didn't), it never claims success
    it can't confirm.
    """
    try:
        from homeassistant.components import assist_pipeline
    except ImportError:
        return (
            "The model file is installed in `/share/openwakeword`, but the "
            "Assist pipeline integration isn't loaded, so it couldn't be "
            'auto-selected. Pick "Rose" manually under '
            "**Settings → Voice assistants**."
        )

    registry = er.async_get(hass)

    rose_entity_id = next(
        (
            ent.entity_id
            for ent in registry.entities.values()
            if ent.config_entry_id == entry.entry_id and ent.domain == "conversation"
        ),
        None,
    )

    wake_word_entities = [
        ent.entity_id for ent in registry.entities.values() if ent.domain == "wake_word"
    ]

    if not wake_word_entities:
        return (
            "The model file is installed in `/share/openwakeword`, ready for "
            "when you set up a wake-word provider (e.g. the openWakeWord "
            "add-on) — none is configured yet. Once it is, pick \"Rose\" "
            "under **Settings → Voice assistants**."
        )

    if len(wake_word_entities) > 1:
        return (
            "The model file is installed in `/share/openwakeword`. You have "
            f"more than one wake-word provider set up "
            f"({', '.join(wake_word_entities)}), so which one should use "
            '"Rose" is ambiguous — pick it manually under '
            "**Settings → Voice assistants**."
        )

    wake_word_entity_id = wake_word_entities[0]

    try:
        pipelines = assist_pipeline.async_get_pipelines(hass)
    except (AttributeError, TypeError):
        _LOGGER.debug(
            "assist_pipeline.async_get_pipelines unavailable/changed shape "
            "on this HA version; falling back to manual instructions",
            exc_info=True,
        )
        return (
            "The model file is installed in `/share/openwakeword`. Pick "
            '"Rose" manually under **Settings → Voice assistants**.'
        )

    updated: list[str] = []
    left_alone: list[str] = []
    for pipeline in pipelines:
        engine = getattr(pipeline, "conversation_engine", None)
        if engine not in (entry.entry_id, rose_entity_id, "conversation.rose"):
            continue
        if getattr(pipeline, "wake_word_entity", None):
            left_alone.append(pipeline.name)
            continue
        try:
            # async_update_pipeline's sync-vs-coroutine signature isn't
            # something to assume across HA versions without a live check —
            # await it only if it actually returned something awaitable, so
            # this can't silently no-op as an unawaited coroutine.
            result = assist_pipeline.async_update_pipeline(
                hass,
                pipeline,
                wake_word_entity=wake_word_entity_id,
                wake_word_id=_WAKE_WORD_ID,
            )
            if inspect.isawaitable(result):
                await result
            updated.append(pipeline.name)
        except (AttributeError, TypeError, ValueError):
            _LOGGER.exception(
                "Couldn't update pipeline %r with the Rose wake word", pipeline.name
            )
            left_alone.append(pipeline.name)

    if updated:
        msg = f'"Rose" is now the active wake word for: {", ".join(updated)}.'
        if left_alone:
            msg += (
                f" Left {', '.join(left_alone)} alone (already had a wake "
                "word set) — switch it manually if you want Rose there too."
            )
        return msg

    if left_alone:
        return (
            "The model file is installed in `/share/openwakeword`, but every "
            f"pipeline using ROSE already has a wake word set "
            f"({', '.join(left_alone)}) — left as-is. Switch to \"Rose\" "
            "manually under **Settings → Voice assistants** if you want it."
        )

    return (
        "The model file is installed in `/share/openwakeword`, but no "
        "Assist pipeline is using ROSE as its conversation agent yet, so "
        'there was nothing to auto-select. Once one is, pick "Rose" as its '
        "wake word under **Settings → Voice assistants**."
    )


def _notify(hass: HomeAssistant, message: str) -> None:
    from homeassistant.components.persistent_notification import async_create

    async_create(hass, message, title="ROSE wake word", notification_id=_NOTIFICATION_ID)
