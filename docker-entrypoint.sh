#!/bin/sh
set -eu
case "${1:-serve}" in
  check|summary|discover) exec node /app/bot.mjs "$@" ;;
esac
exec 9>/app/data/.process.lock
flock -n 9 || { echo 'Учёт уже открыт. Остановите бота перед импортом.' >&2; exit 1; }
export LEDGER_LOCK_MANAGED=1
exec node /app/bot.mjs "$@"
