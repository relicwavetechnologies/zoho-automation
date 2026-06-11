"""AES-256-GCM token decryption — native port of Divo's ``token.crypto.ts``.

Divo stores Zoho/Google OAuth tokens encrypted at rest in Postgres. The
transformed Hermes runtime reads those rows directly and decrypts them in
process, so this must match Divo's scheme byte-for-byte.

Reference: ``advance-backend/src/infrastructure/shared/token.crypto.ts``

Key derivation:
  - ``base64:<...>`` prefix → base64-decode the remainder (must be 32 bytes).
  - otherwise → SHA-256 of the raw string → 32-byte key.

Cipher text format: ``v1:<iv_b64>:<tag_b64>:<ciphertext_b64>``
  - IV: 12 bytes (96-bit GCM nonce)
  - tag: 16 bytes (GCM auth tag), stored separately from ciphertext
  - the Python AESGCM API expects ``ciphertext || tag``, so we append the tag

The encryption key env var is ``ZOHO_TOKEN_ENCRYPTION_KEY`` (same key Divo uses
for both Zoho and Google in production).

Decrypt-only by design: this phase treats the credential store as read-only, so
no ``encrypt_token`` is provided. If/when Hermes owns the write path (token
refresh persisted back to Postgres), add the matching encrypt here.
"""

from __future__ import annotations

import base64
import hashlib
import os

DEFAULT_KEY_ENV = "ZOHO_TOKEN_ENCRYPTION_KEY"
_CIPHER_PREFIX = "v1"
_BASE64_KEY_PREFIX = "base64:"


class TokenCryptoError(RuntimeError):
    """Raised when a token cannot be decrypted (bad key, format, or data)."""


def _to_key_bytes(raw: str) -> bytes:
    raw = raw.strip()
    if not raw:
        raise TokenCryptoError("Token encryption key is empty or not configured")
    if raw.startswith(_BASE64_KEY_PREFIX):
        key = base64.b64decode(raw[len(_BASE64_KEY_PREFIX):])
        if len(key) != 32:
            raise TokenCryptoError("base64 encryption key must resolve to 32 bytes")
        return key
    # SHA-256 of the raw string → deterministic 32-byte key
    return hashlib.sha256(raw.encode("utf-8")).digest()


def resolve_key(encryption_key: str | None = None) -> bytes:
    """Resolve the 32-byte AES key from an explicit value or the env var."""
    raw = encryption_key if encryption_key is not None else os.getenv(DEFAULT_KEY_ENV, "")
    return _to_key_bytes(raw or "")


def decrypt_token(cipher_text: str, encryption_key: str | None = None) -> str:
    """Decrypt a ``v1:<iv>:<tag>:<data>`` token. Raises ``TokenCryptoError``."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    raw = (cipher_text or "").strip()
    parts = raw.split(":")
    if len(parts) != 4 or not parts[0].startswith("v"):
        raise TokenCryptoError(
            "Invalid encrypted token format (expected v1:<iv>:<tag>:<data>)"
        )

    key = resolve_key(encryption_key)
    try:
        iv = base64.b64decode(parts[1])
        tag = base64.b64decode(parts[2])
        data = base64.b64decode(parts[3])
    except (ValueError, base64.binascii.Error) as exc:  # type: ignore[attr-defined]
        raise TokenCryptoError("Encrypted token contained invalid base64") from exc

    try:
        # Python's AESGCM expects ciphertext concatenated with the 16-byte tag.
        plaintext = AESGCM(key).decrypt(iv, data + tag, None)
    except Exception as exc:  # noqa: BLE001 — normalize to one error type
        raise TokenCryptoError(
            "Token decryption failed — key mismatch or data corrupted"
        ) from exc

    return plaintext.decode("utf-8")


def try_decrypt_token(
    cipher_text: str | None, encryption_key: str | None = None
) -> str | None:
    """Decrypt, returning ``None`` for empty input or on failure (never raises)."""
    if not cipher_text:
        return None
    try:
        return decrypt_token(cipher_text, encryption_key)
    except TokenCryptoError:
        return None
