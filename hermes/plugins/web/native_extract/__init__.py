"""Built-in (free) web extractor plugin — bundled, auto-loaded.

``provider.py`` holds the provider class; ``register(ctx)`` registers an
instance. No API key required — extracts page content via httpx + trafilatura.
"""

from __future__ import annotations

from plugins.web.native_extract.provider import NativeExtractProvider


def register(ctx) -> None:
    """Register the built-in free extractor with the plugin context."""
    ctx.register_web_search_provider(NativeExtractProvider())
