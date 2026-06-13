"""Enterprise runtime persistence contracts for Hermes-Divo."""

from .config import EnterprisePostgresConfig
from .schema import (
    ENTERPRISE_TABLES,
    REQUIRED_IDENTITY_CONTEXT_KEYS,
)
from .identity import EnterpriseIdentityEnvelope
from .identity_repository import EnterpriseIdentityRepository, ResolvedCompanyIdentity
from .runtime_events import (
    RuntimeEvent,
    RuntimeEventNormalizer,
    RuntimeIdentityContext,
    RuntimeRunContext,
)
from .runtime_repository import (
    EnterpriseRuntimeHistoryWriter,
    EnterpriseRuntimeRepository,
    SessionBindingInput,
)
from .session_repository import CompanySessionScope, EnterpriseSessionRepository
from .session_store import (
    DashboardCompanyIdentity,
    company_enterprise_session_mode,
    current_company_session_scope,
    get_enterprise_session_repository,
    use_enterprise_session_store_from_env,
)

__all__ = [
    "CompanySessionScope",
    "DashboardCompanyIdentity",
    "ENTERPRISE_TABLES",
    "EnterpriseIdentityEnvelope",
    "EnterpriseIdentityRepository",
    "EnterprisePostgresConfig",
    "EnterpriseRuntimeHistoryWriter",
    "EnterpriseRuntimeRepository",
    "EnterpriseSessionRepository",
    "REQUIRED_IDENTITY_CONTEXT_KEYS",
    "ResolvedCompanyIdentity",
    "RuntimeEvent",
    "RuntimeEventNormalizer",
    "RuntimeIdentityContext",
    "RuntimeRunContext",
    "SessionBindingInput",
    "company_enterprise_session_mode",
    "current_company_session_scope",
    "get_enterprise_session_repository",
    "use_enterprise_session_store_from_env",
]
