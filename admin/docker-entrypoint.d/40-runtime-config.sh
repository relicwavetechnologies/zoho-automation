#!/bin/sh
set -eu

key="${LOGO_DEV_PUBLISHABLE_KEY:-}"
case "${key}" in
  pk_*)
    suffix="${key#pk_}"
    case "${suffix}" in ""|*[!A-Za-z0-9]*) key="" ;; esac
    ;;
  *) key="" ;;
esac

printf 'window.__DIVO_RUNTIME_CONFIG__ = Object.freeze({logoDevPublishableKey:"%s"})\n' "${key}" \
  > /usr/share/nginx/html/runtime-config.js
