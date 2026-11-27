#!/usr/bin/env bash
# Read the immutable image revision of one running service in the rootless dev daemon.
set -Eeuo pipefail
[[ "$EUID" != 0 && "$(id -un)" == opencode-dev && "$#" == 2 ]] || exit 2
project="${COMPOSE_PROJECT_NAME:?Set ENV_COMPOSE_PROJECT_NAME in the registered contour}"
service="${DEV_STATUS_SERVICE:?Set ENV_DEV_STATUS_SERVICE in the registered contour}"
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ && "$service" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || exit 2
socket="/run/user/$EUID/docker.sock"
[[ "${DOCKER_HOST:-}" == "unix://$socket" && -S "$socket" && ! -L "$socket" &&
   "$(stat -c %u "$socket")" == "$EUID" ]] || exit 2

security="$(docker info --format '{{json .SecurityOptions}}')"
[[ "$security" == *'name=rootless'* ]] || exit 2
running="$(docker ps --quiet --no-trunc --filter "label=com.docker.compose.project=$project" \
  --filter "label=com.docker.compose.service=$service" --filter status=running)"
[[ "$running" =~ ^[a-f0-9]{64}$ ]] || exit 2
image="$(docker inspect --type container --format '{{.Image}}' "$running")"
[[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 2
revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")"
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || exit 2
printf '{"sha":"%s"}\n' "$revision"
