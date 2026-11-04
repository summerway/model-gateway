#!/usr/bin/env bash
# import-from-pi.sh — 把 pi 现有的 GPT (openai-codex) OAuth 凭据导入网关 secrets 目录。
#
# 用法:
#   scripts/import-from-pi.sh [目标secrets目录]           # 默认 config/secrets
#   scripts/import-from-pi.sh config/secrets ~/.pi/agent/auth.json  # 显式指定源文件
#
# 行为:
#   1. 探测 pi auth.json（--source 未给时按序探测）:
#        $PI_AUTH_JSON > ~/.pi/agent/auth.json > ~/.config/pi/auth.json
#   2. 提取 openai-codex OAuth 块（jq/python3 任一可用即可），转网关凭据形态
#      写入 <secrets>/codex.json，权限 600（目录 700）。
#   3. 幂等: 已存在 codex.json 时默认跳过（--force 覆盖，--if-stale 仅当源更新时覆盖）。
#
# 绝不打印凭据内容；退出码: 0 成功 / 1 探测失败 / 2 解析失败 / 3 无 openai-codex 块。

set -euo pipefail

SECRETS_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)/config/secrets}"
SOURCE_ARG="${2:-}"

log() { printf '[import-from-pi] %s\n' "$*"; }
die() { printf '[import-from-pi] ERROR: %s\n' "$*" >&2; exit "${2:-1}"; }

FORCE=0
IF_STALE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --if-stale) IF_STALE=1 ;;
  esac
done

# ---- 1. 探测源文件 ----
PI_AUTH=""
for candidate in "${SOURCE_ARG:-}" "${PI_AUTH_JSON:-}" "$HOME/.pi/agent/auth.json" "$HOME/.config/pi/auth.json"; do
  [ -n "$candidate" ] || continue
  if [ -f "$candidate" ]; then PI_AUTH="$candidate"; break; fi
done
[ -n "$PI_AUTH" ] || die "未找到 pi auth.json（探测: \$PI_AUTH_JSON, ~/.pi/agent/auth.json, ~/.config/pi/auth.json）；可用第 2 参数显式指定" 1
log "源: $PI_AUTH"

# ---- 2. 提取并转换 ----
convert_with_python() {
  python3 - "$PI_AUTH" <<'PYEOF'
import json, sys, base64

src_path, = sys.argv[1:]
data = json.load(open(src_path))
entry = data.get("openai-codex") or {}
if entry.get("type") != "oauth" or not entry.get("access") or not entry.get("refresh"):
    sys.exit(3)

def account_id_from_jwt(token):
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        claim = json.loads(base64.urlsafe_b64decode(payload)).get("https://api.openai.com/auth", {})
        aid = claim.get("chatgpt_account_id")
        return aid if isinstance(aid, str) and aid else None
    except Exception:
        return None

out = {
    "type": "oauth",
    "access": entry["access"],
    "refresh": entry["refresh"],
    "idToken": None,
    "expires": entry.get("expires", 0) or 0,
    "accountId": entry.get("accountId") or account_id_from_jwt(entry["access"]),
}
json.dump(out, sys.stdout, indent=2)
print()
PYEOF
}

convert_with_jq() {
  jq '."openai-codex" | select(.type == "oauth" and .access and .refresh) |
      {type: "oauth", access: .access, refresh: .refresh, idToken: null,
       expires: (.expires // 0), accountId: (.accountId // null)}' "$PI_AUTH"
}

CREDS=""
if command -v python3 >/dev/null 2>&1; then
  CREDS="$(convert_with_python)" || exit 3
elif command -v jq >/dev/null 2>&1; then
  CREDS="$(convert_with_jq)" || exit 3
  CREDS="$(printf '%s' "$CREDS" | python3 -c 'import json,sys; d=json.load(sys.stdin); d.setdefault("expires",0); print(json.dumps(d,indent=2))' 2>/dev/null || printf '%s' "$CREDS")"
else
  die "需要 python3 或 jq 之一来解析 auth.json" 2
fi
[ -n "$CREDS" ] || die "解析失败或 auth.json 无 openai-codex OAuth 块" 3

# ---- 3. 写入 secrets ----
mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"
TARGET="$SECRETS_DIR/codex.json"

if [ -f "$TARGET" ] && [ "$FORCE" -eq 0 ]; then
  if [ "$IF_STALE" -eq 1 ]; then
    src_newer=false
    if command -v stat >/dev/null 2>&1; then
      if [ "$(stat -c %Y "$PI_AUTH" 2>/dev/null || stat -f %m "$PI_AUTH" 2>/dev/null)" -gt "$(stat -c %Y "$TARGET" 2>/dev/null || stat -f %m "$TARGET" 2>/dev/null)" ]; then
        src_newer=true
      fi
    fi
    if [ "$src_newer" != true ]; then
      log "目标已存在且源不比目标新，跳过（--force 覆盖）: $TARGET"
      exit 0
    fi
  else
    log "目标已存在，跳过（--force 覆盖）: $TARGET"
    exit 0
  fi
fi

umask 177
printf '%s\n' "$CREDS" > "$TARGET"
chmod 600 "$TARGET"
log "已写入: $TARGET ($(stat -c '%a bytes=%s' "$TARGET" 2>/dev/null || stat -f '%Lp bytes=%z' "$TARGET"))"
log "accountId: $(python3 -c "import json;print(json.load(open('$TARGET')).get('accountId') or '(absent)')" 2>/dev/null || echo '(unknown)')"
log "完成。启动时网关将从该文件加载并按需刷新 token。"
