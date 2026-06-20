"""Static integration plugin manifest models for the Divo Dex dashboard."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

AuthModel = Literal["oauth", "manual", "company_service_account", "none"]
ConnectionScope = Literal["user", "company"]
CapabilityRuntimeStatus = Literal[
    "available",
    "needs_connection",
    "needs_scope",
    "unavailable",
]
ConnectionStatus = Literal[
    "not_connected",
    "connected",
    "needs_reconnect",
    "revoked",
]


@dataclass(frozen=True)
class IntegrationPluginScopeDef:
    id: str
    label: str
    description: str
    required: bool = True


@dataclass(frozen=True)
class IntegrationPluginCapabilityDef:
    id: str
    label: str
    description: str
    tool_name: str | None = None
    required_scopes: tuple[str, ...] = ()
    phase: int = 1


@dataclass(frozen=True)
class IntegrationPluginManifest:
    id: str
    name: str
    description: str
    category: str
    featured: bool
    logo_key: str
    auth_model: AuthModel
    connector_provider: str
    connection_scope: ConnectionScope
    oauth_scopes: tuple[IntegrationPluginScopeDef, ...] = ()
    capabilities: tuple[IntegrationPluginCapabilityDef, ...] = ()
    examples: tuple[str, ...] = ()
    env_requirements: tuple[str, ...] = ()

    def to_public_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["oauth_scopes"] = [asdict(scope) for scope in self.oauth_scopes]
        payload["capabilities"] = [
            {
                "id": capability.id,
                "label": capability.label,
                "description": capability.description,
                "tool_name": capability.tool_name,
                "required_scopes": list(capability.required_scopes),
                "phase": capability.phase,
            }
            for capability in self.capabilities
        ]
        payload["examples"] = list(self.examples)
        payload["env_requirements"] = list(self.env_requirements)
        return payload


@dataclass(frozen=True)
class IntegrationPluginConnectionView:
    status: ConnectionStatus
    account_email: str | None = None
    granted_scopes: tuple[str, ...] = ()
    connected_at: str | None = None
    credential_id: str | None = None


@dataclass(frozen=True)
class IntegrationPluginCapabilityView:
    id: str
    label: str
    description: str
    tool_name: str | None
    status: CapabilityRuntimeStatus
    phase: int = 1


@dataclass(frozen=True)
class IntegrationPluginActions:
    can_connect: bool
    can_disconnect: bool
    can_manage_admin: bool


@dataclass
class IntegrationPluginStatusView:
    id: str
    manifest: dict[str, Any]
    connection: dict[str, Any]
    capabilities: list[dict[str, Any]] = field(default_factory=list)
    actions: dict[str, bool] = field(default_factory=dict)
    admin_stats: dict[str, Any] | None = None
