# Managed 1c-buddy MCP

Upstream: https://github.com/ROCTUP/1c-buddy ; exact Git revision in `source.lock` (version 1.4.1 at initial pin). Upstream is AGPL-3.0-only. Upstream explicitly warns that accessing code.1c.ai through third-party clients may violate its user agreement; confirm permission before using it.

`install.sh` invokes `scripts/install-mcp.sh` after installing OpenCode and loading `~/.config/opencode.env`. Requirements: GitHub CLI authenticated, Docker Engine and Docker Compose v2 accessible, Python 3.13 via uv, and a nonempty `ONEC_AI_TOKEN` in the local env file. Neither secrets nor upstream source are committed to my-opencode: source is fetched at exact SHA to `~/.local/share/my-opencode/mcp/1c-buddy/<sha>` and a single-token container env file is created with mode 0600 at `~/.local/state/my-opencode/1c-buddy.env`.

The managed container name is `my-opencode-1c-buddy`; port `6002` binds **only 127.0.0.1**. Existing containers lacking the `my-opencode.managed=true` label are never taken over or removed. If another process/container owns port 6002, installation fails without changing it. Do not expose `/mcp` through Nginx or a public interface: upstream HTTP MCP has no authentication.

If the MCP client runs on another host, loopback won't work. Use an authenticated transport/tunnel and a separately reviewed OpenCode URL; do not change the Docker bind to `0.0.0.0`.

Read-only checks: `docker ps --filter name=my-opencode-1c-buddy`, `docker inspect -f '{{.State.Health.Status}}' my-opencode-1c-buddy`, `curl --noproxy '*' -fsS http://127.0.0.1:6002/health`, `opencode mcp list`. Don't paste Docker inspect environment, `.env` content or unredacted logs: these may include `ONEC_AI_TOKEN`.

To reinstall, run the GitHub-sourced `install.sh` in the intended **non-root account** with Docker access. Do not use `sudo bash` without preserving the intended HOME and runtime-user context. The installer must not change unknown containers or delete volumes. Refreshing upstream requires review and an explicit change to `source.lock`; never use a floating image tag.
