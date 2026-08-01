#!/bin/bash
# ============================================================
# opencode-agents-fix.sh — восстановление канонической структуры агентов
# Страховка на случай, если правки структуры сломали конфиг.
#
# КАНОН (единственный источник): ~/.opencode/agent/  (install-дир, читается бинарником)
# ЗЕРКАЛО (backup в git):        my-opencode/config/opencode/agent/
#
# ОПАСНЫЕ ПУТИ (НЕ должны существовать / должны быть пустыми):
#   ~/.config/opencode/agent/    (singular — legacy-дубль, НЕ читается)
#   ~/.config/opencode/agents/   (plural — старый набор, заменён install-диром)
#
# СЦЕНАРИИ:
#   --check    только проверить состояние (ничего не менять)
#   --restore  восстановить канон из зеркала git (если ~/.opencode/agent сломан)
#   --deploy   развернуть канон из зеркала git в ~/.opencode/agent + ~/.config
#   --purge    удалить ОПАСНЫЕ пути (singular/plural дубли)
# ============================================================
set -euo pipefail

REPO=/home/guber/Opencode/my-opencode
CANON=/home/guber/.opencode/agent
GLOBAL_AGENT=/home/guber/.config/opencode/agent
GLOBAL_AGENTS=/home/guber/.config/opencode/agents
MIRROR="$REPO/config/opencode/agent"

log()  { echo -e "\033[1;32m[fix]\033[0m $*"; }
warn() { echo -e "\033[1;33m[fix!]\033[0m $*"; }
die()  { echo -e "\033[1;31m[fix!!]\033[0m $*" >&2; exit 1; }

check() {
    log "=== CHECK ==="
    [ -d "$CANON" ]       && log "канон OK:  $CANON"            || die "НЕТ канона: $CANON"
    [ -f "$CANON/opencode.json" ] || warn "в каноне нет opencode.json (не критично)"
    [ -d "$MIRROR" ]      && log "зеркало OK: $MIRROR"          || warn "НЕТ зеркала: $MIRROR"
    [ -d "$GLOBAL_AGENT" ]   && warn "singular-дубль СУЩЕСТВУЕТ: $GLOBAL_AGENT (не читается, мешает)" || log "singular-дубля нет: OK"
    [ -d "$GLOBAL_AGENTS" ]  && warn "plural-набор СУЩЕСТВУЕТ: $GLOBAL_AGENTS (старый)"              || log "plural-набора нет: OK"
    # сравнение канона и зеркала
    if [ -d "$MIRROR" ]; then
        if diff -rq "$CANON" "$MIRROR" >/dev/null 2>&1; then
            log "канон ≡ зеркало: OK"
        else
            warn "канон ≠ зеркало (см. diff -rq $CANON $MIRROR)"
        fi
    fi
    log "=== CHECK DONE ==="
}

restore() {
    [ -d "$MIRROR" ] || die "нет зеркала для restore: $MIRROR"
    log "RESTORE: $MIRROR -> $CANON"
    mkdir -p "$CANON"
    cp -r "$MIRROR"/. "$CANON"/
    log "RESTORE DONE. Перезапустите сервис: systemctl --user restart opencode-web"
}

deploy() {
    restore
    # также обновить singular-зеркало (чтобы у пользователя было откуда смотреть)
    if [ -d "$GLOBAL_AGENT" ]; then
        log "DEPLOY: обновляю $GLOBAL_AGENT из канона"
        cp -r "$CANON"/. "$GLOBAL_AGENT"/
    fi
}

purge() {
    log "PURGE: удаляю singular-дубль $GLOBAL_AGENT"
    if [ -d "$GLOBAL_AGENT" ]; then
        rm -rf "$GLOBAL_AGENT" && log "удалён: $GLOBAL_AGENT" || die "не удалось удалить $GLOBAL_AGENT"
    fi
    log "PURGE: удаляю plural-набор $GLOBAL_AGENTS"
    if [ -d "$GLOBAL_AGENTS" ]; then
        rm -rf "$GLOBAL_AGENTS" && log "удалён: $GLOBAL_AGENTS" || die "не удалось удалить $GLOBAL_AGENTS"
    fi
    log "PURGE DONE. Перезапустите сервис: systemctl --user restart opencode-web"
}

case "${1:---check}" in
    --check)   check ;;
    --restore) restore ;;
    --deploy)  deploy ;;
    --purge)   purge ;;
    *) die "usage: $0 [--check|--restore|--deploy|--purge]" ;;
esac
