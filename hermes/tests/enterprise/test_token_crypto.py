"""Tests for the native AES-256-GCM token crypto (port of token.crypto.ts)."""

import base64

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from enterprise.token_crypto import (
    TokenCryptoError,
    decrypt_token,
    encrypt_token,
    resolve_key,
    try_decrypt_token,
)


def _encrypt_like_divo(plaintext: str, key: bytes, iv: bytes) -> str:
    """Reproduce token.crypto.ts encrypt: v1:<iv>:<tag>:<ciphertext>."""
    sealed = AESGCM(key).encrypt(iv, plaintext.encode("utf-8"), None)
    ciphertext, tag = sealed[:-16], sealed[-16:]
    return (
        f"v1:{base64.b64encode(iv).decode()}:"
        f"{base64.b64encode(tag).decode()}:"
        f"{base64.b64encode(ciphertext).decode()}"
    )


def test_round_trip_with_base64_key():
    key = b"0" * 32
    raw_key = "base64:" + base64.b64encode(key).decode()
    token = _encrypt_like_divo("1000.secrettoken", key, iv=b"x" * 12)
    assert decrypt_token(token, raw_key) == "1000.secrettoken"


def test_encrypt_token_round_trip_uses_native_format():
    key = b"0" * 32
    raw_key = "base64:" + base64.b64encode(key).decode()
    token = encrypt_token("native-secret", raw_key)

    assert token.startswith("v1:")
    assert decrypt_token(token, raw_key) == "native-secret"


def test_round_trip_with_sha256_derived_key():
    raw_key = "a-passphrase-not-base64"
    key = resolve_key(raw_key)
    assert len(key) == 32
    token = _encrypt_like_divo("hello world", key, iv=b"y" * 12)
    assert decrypt_token(token, raw_key) == "hello world"


def test_base64_key_must_be_32_bytes():
    with pytest.raises(TokenCryptoError):
        resolve_key("base64:" + base64.b64encode(b"short").decode())


def test_bad_format_raises():
    with pytest.raises(TokenCryptoError):
        decrypt_token("not-a-valid-token", "base64:" + base64.b64encode(b"0" * 32).decode())


def test_wrong_key_raises():
    key = b"0" * 32
    token = _encrypt_like_divo("data", key, iv=b"z" * 12)
    wrong = "base64:" + base64.b64encode(b"1" * 32).decode()
    with pytest.raises(TokenCryptoError):
        decrypt_token(token, wrong)


def test_try_decrypt_returns_none_on_failure_and_empty():
    assert try_decrypt_token(None) is None
    assert try_decrypt_token("") is None
    assert try_decrypt_token("garbage", "base64:" + base64.b64encode(b"0" * 32).decode()) is None
