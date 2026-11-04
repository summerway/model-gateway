#!/bin/bash
# claude-activator-runner.sh — claude 5h 窗口激活执行器（model-gateway sidecar）
#
# 背景（两条已付学费的错误经验，2026-10-19 重实现）：
#  1. 网关进程内直发订阅 OAuth /v1/messages 会被 Anthropic 客户端指纹门控
#     429（2026-10-14 对照实验：同 token/IP 同分钟，真 CLI 200、裸请求 429；
#     CLI 指纹含 x-app / User-Agent (external, cli) / X-Claude-Code-Session-Id /
#     anthropic-beta + 带 tk 签名的 metadata.user_id，伪装不可持续）。
#     → 激活请求必须由真 Claude Code CLI 发出：本脚本就是真客户端。
#  2. 「Claude 5h 窗口滚动、闲置零损失、无需激活」结论已被推翻：闲置只是
#     推迟下一窗口开启，背靠背锚定才有最大吞吐（与 GLM 同理）。
#
# 工作方式：轮询网关 /internal/activator/claude/claim 领取到期激活回合 →
# 本机真 CLI 跑一次最小 -p 请求 → 回报结果。状态机（窗口观测/去重/退避/
# 锚定/事件/告警）全部在网关内，本脚本无状态、可随时重启。
# 未到期时网关响应携带 dueAt（下一可领取时刻）→ 睡到点再领（封顶
# MAX_SLEEP，保配置变更/额度状态的可感知延迟）；无 dueAt 退回固定短轮询。
# 环境变量：GATEWAY_URL（默认 http://model-gateway:8080）、POLL_SEC（默认 20，
# 短轮询下限）、MAX_SLEEP（默认 300，dueAt 睡眠上限）。
# GATEWAY_ADMIN_KEY：token 模式的管理端密钥，非空时随请求发送 Bearer。

set -u
GATEWAY_URL="${GATEWAY_URL:-http://model-gateway:8080}"
POLL_SEC="${POLL_SEC:-20}"
MAX_SLEEP="${MAX_SLEEP:-300}"
CLAIM_URL="$GATEWAY_URL/internal/activator/claude/claim"
RESULT_URL="$GATEWAY_URL/internal/activator/claude/result"
WORKDIR="/tmp/claude-activator"
mkdir -p "$WORKDIR"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }

post_json() { # url, json → body (失败输出空串，rc 非零)
  local auth_headers=()
  if [ -n "${GATEWAY_ADMIN_KEY:-}" ]; then
    auth_headers=(-H "authorization: Bearer $GATEWAY_ADMIN_KEY")
  fi
  curl -fsS -m 15 -H 'content-type: application/json' ${auth_headers[@]+"${auth_headers[@]}"} -X POST --data "$2" "$1" 2>/dev/null || true
}

while true; do
  claim="$(post_json "$CLAIM_URL" '{}')"
  if [ -z "$claim" ]; then
    log "claim request failed (gateway unreachable?), retrying in ${POLL_SEC}s"
    sleep "$POLL_SEC"
    continue
  fi

  due="$(printf '%s' "$claim" | jq -r '.due // false')"
  if [ "$due" != "true" ]; then
    # 无到期回合：静默等待（reason 级日志太吵，仅 backoff/quota 变化时打一条）
    reason="$(printf '%s' "$claim" | jq -r '.reason // ""')"
    case "$reason" in
      backoff|quota_exhausted) log "no claim: $reason ($(printf '%s' "$claim" | jq -c '{resumesAt,nextAttemptAt,dueAt}'))" ;;
    esac
    # dueAt（或额度抑制 resumesAt）→ 精确睡到点 +1s（封顶 MAX_SLEEP）；
    # 否则退回固定 POLL_SEC 短轮询。
    sleep_for=$POLL_SEC
    due_at="$(printf '%s' "$claim" | jq -r '.dueAt // .resumesAt // empty')"
    if [ -n "$due_at" ]; then
      due_ep="$(date -d "$due_at" +%s 2>/dev/null || echo 0)"
      if [ "$due_ep" -gt 0 ]; then
        delta=$(( due_ep - $(date +%s) + 1 ))
        [ "$delta" -gt "$MAX_SLEEP" ] && delta=$MAX_SLEEP
        [ "$delta" -gt "$sleep_for" ] && sleep_for=$delta
      fi
    fi
    sleep "$sleep_for"
    continue
  fi

  claim_id="$(printf '%s' "$claim" | jq -r '.claimId')"
  model="$(printf '%s' "$claim" | jq -r '.model')"
  prompt="$(printf '%s' "$claim" | jq -r '.prompt')"
  timeout_sec="$(printf '%s' "$claim" | jq -r '.timeoutSec')"
  task="$(printf '%s' "$claim" | jq -r '.task // "activate"')"
  reset_for="$(printf '%s' "$claim" | jq -r '.resetFor // "n/a"')"
  log "claim $claim_id: task=$task (resetFor=$reset_for model=$model timeout=${timeout_sec}s)"
  # task=token-refresh：真 CLI 启动时完成 OAuth token 轮换（过期即刷新），
  # 同一最小轮次；成功与否由网关验凭据文件 expiresAt 前移判定，本脚本无差别执行。

  started=$(date +%s%3N)
  out_file="$WORKDIR/last-run.out"
  # 真 Claude Code 客户端请求：-p 单轮、禁 MCP（轻量、无副作用）。共享
  # CLAUDE_CONFIG_DIR 由外部 claude 包装器注入；token 过期
  # 由 CLI 自行刷新（这正是「真客户端」的意义）。
  timeout "${timeout_sec}" claude -p "$prompt" \
    --model "$model" \
    --max-turns 1 \
    --output-format text \
    --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
    </dev/null >"$out_file" 2>&1
  rc=$?
  duration=$(( $(date +%s%3N) - started ))

  if [ "$rc" -eq 0 ]; then
    result="{\"claimId\":\"$claim_id\",\"ok\":true,\"durationMs\":$duration}"
    log "claim $claim_id: OK in ${duration}ms ($(head -c 80 "$out_file" | tr '\n' ' '))"
  else
    # 124=timeout；其余 rc 带上输出尾部（截 300，与网关事件口径一致）
    err="$(tail -c 300 "$out_file" | tr '\n' ' ' | sed 's/"/\\"/g')"
    [ "$rc" -eq 124 ] && err="cli timeout after ${timeout_sec}s: $err"
    result="{\"claimId\":\"$claim_id\",\"ok\":false,\"status\":$rc,\"error\":\"$err\",\"durationMs\":$duration}"
    log "claim $claim_id: FAILED rc=$rc in ${duration}ms: $err"
  fi

  resp="$(post_json "$RESULT_URL" "$result")"
  [ -z "$resp" ] && log "result report failed for $claim_id (gateway will expire the claim and retry)"
  sleep "$POLL_SEC"
done
