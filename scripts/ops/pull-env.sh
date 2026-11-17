#!/usr/bin/env bash
# Bootstrap production env vars from Vercel into .env.local.
# Requires: VERCEL_TOKEN (create at https://vercel.com/account/tokens), or a
# local operator token in macOS Keychain / ~/.codex/secrets/goose.gifts/vercel-token.
# Usage: ./scripts/ops/pull-env.sh [output-file]
#
# Values are written single-quoted (shell-safe), so the file works both with
# dotenv loaders and `set -a; source .env.local; set +a`.
set -euo pipefail

load_vercel_token() {
  if [[ -n "${VERCEL_TOKEN:-}" ]]; then
    return
  fi

  if command -v security >/dev/null 2>&1; then
    VERCEL_TOKEN="$(
      security find-generic-password \
        -a goose.gifts \
        -s goose.gifts.VERCEL_TOKEN \
        -w 2>/dev/null || true
    )"
    if [[ -n "$VERCEL_TOKEN" ]]; then
      export VERCEL_TOKEN
      return
    fi
  fi

  local token_file="${VERCEL_TOKEN_FILE:-$HOME/.codex/secrets/goose.gifts/vercel-token}"
  if [[ -r "$token_file" ]]; then
    VERCEL_TOKEN="$(tr -d '\r\n' < "$token_file")"
    if [[ -n "$VERCEL_TOKEN" ]]; then
      export VERCEL_TOKEN
      return
    fi
  fi
}

load_vercel_token
: "${VERCEL_TOKEN:?VERCEL_TOKEN is required (env var, macOS Keychain service goose.gifts.VERCEL_TOKEN, or VERCEL_TOKEN_FILE)}"
export ENV_OUT="${1:-.env.local}"

if ! command -v node >/dev/null 2>&1; then
  for node_dir in \
    "/opt/homebrew/bin" \
    "/usr/local/bin" \
    "$HOME/.nvm/versions/node/v26.13.1/bin"; do
    if [[ -x "$node_dir/node" ]]; then
      export PATH="$node_dir:$PATH"
      break
    fi
  done
fi

command -v node >/dev/null 2>&1 || {
  echo "ERROR: node is required to pull Vercel env vars" >&2
  exit 1
}

script_file="$(mktemp "${TMPDIR:-/tmp}/goose-pull-env.XXXXXX.mjs")"
trap 'rm -f "$script_file"' EXIT

cat > "$script_file" <<'EOF'
const token = process.env.VERCEL_TOKEN;
const out = process.env.ENV_OUT;

async function api(path) {
  const res = await fetch('https://api.vercel.com' + path, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

// Scopes: personal (no teamId) plus every team on the account.
const scopes = [''];
try {
  const { teams = [] } = await api('/v2/teams');
  scopes.push(...teams.map((t) => t.id));
} catch { /* token may be project-scoped; personal scope still works */ }

// Find the goose.gifts project across scopes.
let projectId = null, teamQs = '';
for (const scope of scopes) {
  const qs = scope ? `?teamId=${scope}` : '';
  const { projects = [] } = await api(`/v9/projects${qs ? qs + '&' : '?'}search=goose`);
  if (projects.length) {
    projectId = projects[0].id;
    teamQs = scope ? `?teamId=${scope}` : '';
    console.error(`Found project: ${projects[0].name} (${projectId})`);
    break;
  }
}
if (!projectId) { console.error("ERROR: no project matching 'goose' found"); process.exit(1); }

// The list endpoint returns values encrypted; fetch each var individually
// to get the decrypted value (type=sensitive is unreadable by design).
const { envs = [] } = await api(`/v9/projects/${projectId}/env${teamQs}`);
const prod = envs.filter((e) => (e.target || []).includes('production'));

const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`; // shell-safe single-quoting
const localOnlyLines = [`VERCEL_TOKEN=${shq(token)}`];
const lines = [];
let unreadable = 0;
for (const e of prod) {
  const full = await api(`/v9/projects/${projectId}/env/${e.id}${teamQs}`);
  if (full.type === 'sensitive' || full.value === undefined || full.value === null) {
    lines.push(`# UNREADABLE (sensitive): ${full.key}`);
    unreadable++;
  } else {
    lines.push(`${full.key}=${shq(full.value)}`);
  }
}

const { writeFileSync } = await import('node:fs');
writeFileSync(out, [...localOnlyLines, ...lines].join('\n') + '\n', { mode: 0o600 });
console.error(`Wrote VERCEL_TOKEN plus ${lines.length - unreadable} vars to ${out} (${unreadable} unreadable/sensitive)`);
if (unreadable) {
  console.error('Sensitive vars cannot be read via API; ask the owner for those values:');
  for (const l of lines) if (l.startsWith('# UNREADABLE')) console.error(l);
}
EOF

node "$script_file"
