# Накатка принятого серверного кандидата — 2026-11-08

Точная пара: my-opencode `338c26993178f3d681eb3f1c86e17357c63233de`, openchamber-ru `b236258326deaf3541956b8a9cd9bb5aec68da5b`.
Версии: OpenCode 2.2.5, OpenChamber 2.6.1. Проверено на Node 24.22.1 и Bun 1.4.4.

Команды выполняет оператор с уже настроенным GitHub CLI и обычными правами установки. Wrapper сам использует runtime user `opencode`. Здесь нет команды merge/release; production в ходе приёмки не обновлялся.

## 1. Bun для сборки

Если у пользователя opencode установлен старый Bun, обновите его до проверенного 1.4.4. Установщик ставит Bun при отсутствии, но уже установленную старую версию сам не заменяет.

```bash
sudo -u opencode -H bash -c 'curl -fsSL https://bun.com/install | bash -s "bun-v1.4.4"'
sudo -u opencode -H bash -c 'test "$("$HOME/.bun/bin/bun" --version)" = 1.4.4'
```

Формат установки точного тега описан в [официальной документации Bun](https://bun.com/docs/installation#installing-older-versions). Node >=24.14 выбирается через существующий user-local bootstrap дистрибутива; standalone OpenCode сохраняет свой прежний минимум.

## 2. Снимок фактической установленной пары и установка

Для существующей установки. Если state отсутствует, остановитесь и сначала определите фактически установленную пару — не подставляйте вымышленные SHA.

```bash
set -euo pipefail
runtime_home="$(getent passwd opencode | cut -d: -f6)"
test -n "$runtime_home"
state_file="$runtime_home/.local/state/my-opencode/openchamber-v2-install.state"
backup_file="$state_file.before-pipeline-20261108"
sudo -u opencode test -f "$state_file"
if ! sudo -u opencode test -e "$backup_file"; then
  sudo -u opencode cp "$state_file" "$backup_file"
fi
current_state="$(sudo -u opencode cat "$state_file")"
bind_host="$(printf '%s\n' "$current_state" | awk -F= '$1=="bind_host"{print $2}')"
bind_port="$(printf '%s\n' "$current_state" | awk -F= '$1=="bind_port"{print $2}')"
test -n "$bind_host"
test -n "$bind_port"
installer_file="$(mktemp)"
gh api -H 'Accept: application/vnd.github.raw' \
  'repos/gest0r1/my-opencode/contents/install-openchamber.sh?ref=338c26993178f3d681eb3f1c86e17357c63233de' > "$installer_file"
OPENCODE_CONFIG_REF='338c26993178f3d681eb3f1c86e17357c63233de' \
OPENCHAMBER_REF='b236258326deaf3541956b8a9cd9bb5aec68da5b' \
OPENCHAMBER_BIND_HOST="$bind_host" OPENCHAMBER_BIND_PORT="$bind_port" \
OPENCHAMBER_PACKAGE_MODE=source bash "$installer_file"
rm -f "$installer_file"
```

`source` выбран явно: проверенная feature пока не имеет нового release bundle. Если вы обычно передаёте дополнительные installer overrides, сохраните их. Существующие sessions и credentials не удаляются.

## 3. Рабочая проверка

Откройте server UI; проверьте версии и health. На новой небольшой задаче проверьте PLAN по `#issue` и quoted milestone, согласование предмета без автоматического RUN, затем явный RUN, вопрос владельцу/завершение ребёнка и Markdown parent/child export. Повтор на неизменённых входах должен переиспользовать PASS; изменение значимого входа должно инвалидировать его.

Настоящий запуск backend и native plugin activation уже проверены. Приёмка конкретной трактовки новой задачи и измерение экономии на ваших RUN остаются рабочей проверкой. Windows desktop artifact в этом запуске не выпускался; новый UI можно тестировать в браузере.

## 4. Возврат к сохранённой паре

При сбое активации wrapper уже имеет автоматический rollback. Для сознательного возврата после рабочего теста:

```bash
set -euo pipefail
runtime_home="$(getent passwd opencode | cut -d: -f6)"
backup_file="$runtime_home/.local/state/my-opencode/openchamber-v2-install.state.before-pipeline-20261108"
old_state="$(sudo -u opencode cat "$backup_file")"
old_config="$(printf '%s\n' "$old_state" | awk -F= '$1=="config_sha"{print $2}')"
old_app="$(printf '%s\n' "$old_state" | awk -F= '$1=="openchamber_sha"{print $2}')"
bind_host="$(printf '%s\n' "$old_state" | awk -F= '$1=="bind_host"{print $2}')"
bind_port="$(printf '%s\n' "$old_state" | awk -F= '$1=="bind_port"{print $2}')"
[[ "$old_config" =~ ^[a-f0-9]{40}$ && "$old_app" =~ ^[a-f0-9]{40}$ ]]
test -n "$bind_host"
test -n "$bind_port"
installer_file="$(mktemp)"
gh api -H 'Accept: application/vnd.github.raw' \
  "repos/gest0r1/my-opencode/contents/install-openchamber.sh?ref=$old_config" > "$installer_file"
OPENCODE_CONFIG_REF="$old_config" OPENCHAMBER_REF="$old_app" \
OPENCHAMBER_BIND_HOST="$bind_host" OPENCHAMBER_BIND_PORT="$bind_port" \
OPENCHAMBER_PACKAGE_MODE=auto bash "$installer_file"
rm -f "$installer_file"
```

Это возврат к записанным исходникам через прежний установщик, а не SQL rollback или удаление данных. На настоящем рабочем сервере данная команда в ходе этой приёмки не выполнялась.
