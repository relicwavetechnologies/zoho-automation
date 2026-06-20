"""Serper (Google SERP) search plugin — bundled, auto-loaded.

``provider.py`` holds the provider class; ``register(ctx)`` registers an
instance. Requires ``SERPER_API_KEY`` (free tier at https://serper.dev).
"""

from __future__ import annotations

from plugins.web.serper.provider import SerperWebSearchProvider


def register(ctx) -> None:
    """Register the Serper provider with the plugin context."""
    ctx.register_web_search_provider(SerperWebSearchProvider())
