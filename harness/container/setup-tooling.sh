#!/usr/bin/env bash
# Pi port of upstream/bench/container/setup-tooling.sh: installs the AI tooling each
# framework's official docs recommend for coding agents, in the places Pi reads it from,
# and records the exact version of everything it set up.
#
# Differences from the Claude Code original, all forced by the harness:
#   - MCP servers go into Pi's user-level mcp.json with "exposure": "direct", so the model sees
#     them as ordinary tools (Claude Code declares MCP tools directly too). Pi's default,
#     "codemode", would hide them behind a JS-scripting tool.
#   - Skills are installed with `skills add -a pi`, which writes the project's .agents/skills
#     (Claude Code's equivalent is .claude/skills). Pi loads them because run-agent.sh passes
#     --approve.
#   - The Svelte Claude Code plugin is unpacked into its parts: its MCP server and its skills.
#     Its subagent (svelte-file-editor) and LSP server have no Pi equivalent and are recorded
#     as skipped.
#
# Usage: setup-tooling.sh <framework> <mcp-config-out> <versions-out>
set -euo pipefail

FRAMEWORK="$1"
MCP_OUT="$2"
VERSIONS_OUT="$3"
HERE="$(cd "$(dirname "$0")" && pwd)"
RECORDS="$(mktemp)"
cd "${WORK:-/home/agent/work}"

record() { # record <json object>
  jq -e . <<<"$1" > /dev/null || { echo "Bad version record: $1" >&2; exit 1; }
  printf '%s\n' "$1" >> "$RECORDS"
}
npm_version() { npm view "$1" version; }
git_head() { git ls-remote "https://github.com/$1.git" HEAD | cut -f1; }
mcp() { # writes the MCP config: mcp '<json for mcpServers>'
  printf '{ "mcpServers": %s }\n' "$1" | jq . > "$MCP_OUT"
}
stdio_mcp() { # stdio_mcp <server name> <npm package> [args...]: run via npx, pinned
  local name="$1" pkg="$2" version
  shift 2
  version="$(npm_version "$pkg")"
  record "$(jq -nc --arg n "$name" --arg p "$pkg" --arg v "$version" '{kind: "mcp (stdio)", name: $n, package: $p, version: $v}')"
  jq -nc --arg n "$name" --arg spec "$pkg@$version" --args \
    '{($n): {type: "stdio", command: "npx", args: (["-y", $spec] + $ARGS.positional), exposure: "direct"}}' "$@"
}
http_mcp() { # http_mcp <server name> <url>: hosted, can't be pinned, so record what it offers
  local name="$1" url="$2" probe
  probe="$("$HERE/mcp-probe.sh" "$url" 2>/dev/null || echo '{"error": "probe failed"}')"
  record "$(jq -nc --arg n "$name" --arg u "$url" --argjson p "$probe" '{kind: "mcp (hosted)", name: $n, url: $u} + $p')"
  jq -nc --arg n "$name" --arg u "$url" '{($n): {type: "streamable-http", url: $u, exposure: "direct"}}'
}
skill() { # skill <github owner/repo> [skills add args...]: installs into .agents/skills
  local repo="$1" cli commit args
  shift
  cli="$(npm_version skills)"
  commit="$(git_head "$repo")"
  args="$(printf '%s\n' "$@" | jq -R . | jq -sc 'map(select(length > 0))')"
  record "$(jq -nc --arg r "$repo" --arg c "$commit" --arg cli "$cli" --argjson a "$args" '{kind: "skill", repo: $r, commit: $c, args: $a, skillsCli: $cli}')"
  npx -y "skills@$cli" add "https://github.com/$repo" "$@" -a pi -y --copy
}

mcp '{}'
case "$FRAMEWORK" in
  next)
    mcp "$(stdio_mcp next-devtools next-devtools-mcp)"
    skill vercel/next.js --skill next-dev-loop
    ;;
  nuxt)
    mcp "$(http_mcp nuxt https://nuxt.com/mcp)"
    ;;
  astro)
    mcp "$(http_mcp astro-docs https://mcp.docs.astro.build/mcp)"
    ;;
  sveltekit)
    # The plugin's .mcp.json runs `npx -y @sveltejs/mcp`; pinned here like the other stdio servers.
    mcp "$(stdio_mcp svelte @sveltejs/mcp)"
    commit="$(git_head sveltejs/ai-tools)"
    tmp="$(mktemp -d)"
    git -C "$tmp" init -q
    git -C "$tmp" fetch -q --depth 1 https://github.com/sveltejs/ai-tools.git "$commit"
    git -C "$tmp" checkout -q FETCH_HEAD
    mkdir -p .agents/skills
    cp -R "$tmp/plugins/claude/svelte/skills/." .agents/skills/
    record "$(jq -nc --arg c "$commit" --arg s "$(ls "$tmp/plugins/claude/svelte/skills" | jq -R . | jq -sc .)" \
      '{kind: "claude plugin (ported)", name: "svelte@svelte", repo: "sveltejs/ai-tools", commit: $c, skills: ($s | fromjson), skipped: ["agents/svelte-file-editor.md (no subagents in pi)", "lspServers.svelte"]}')"
    rm -rf "$tmp"
    ;;
  angular)
    mcp "$(stdio_mcp angular-cli @angular/cli mcp)"
    skill angular/skills
    ;;
  hono-htmx)
    skill honojs/skills
    ;;
  react-router)
    skill remix-run/react-router --skill react-router
    ;;
  tanstack-start | solidstart | qwik | gracile | vanilla)
    ;;
  *)
    echo "Unknown framework: $FRAMEWORK" >&2
    exit 1
    ;;
esac

jq -s '.' "$RECORDS" > "$VERSIONS_OUT"
rm -f "$RECORDS"
echo "Tooling for $FRAMEWORK:"
cat "$MCP_OUT" "$VERSIONS_OUT"
ls .agents/skills 2>/dev/null || true
