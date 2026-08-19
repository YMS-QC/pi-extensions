#!/usr/bin/env bash
# sync-memory.sh — 原则/知识/记忆 在 pi-extensions (memory/) 与本机 (~/.pi/agent) 间同步
#   ./sync-memory.sh pull   本机 → 仓 (日常快照, 默认)
#   ./sync-memory.sh push   仓 → 本机 (换机/重装恢复)
# 红线: 不碰 sessions.db* / locks / recovery / auth / token; 进仓前密钥扫描, 命中即中止
set -euo pipefail
cd "$(dirname "$0")"
A="$HOME/.pi/agent"
MODE="${1:-pull}"

scan_secrets() {  # $1=file  密钥字段扫描 (与 pi-personal 同口径)
  if grep -qiE '"(botToken|apiKey|api_key|secret|password|authToken)"\s*:\s*"[^"]+"' "$1" 2>/dev/null; then
    echo "REFUSE: $1 疑似密钥, 中止" >&2; exit 1
  fi
}

sync_skills() {  # $1=src $2=dst  --safe-links: 跳过指向树外的符号链接(如 ~/.agents), 避免快照出坏链
  mkdir -p "$2"
  rsync -a --safe-links --exclude='.DS_Store' "$1/" "$2/"
  find "$2" -xtype l -delete 2>/dev/null || true
}

sync_projects() {  # $1=src $2=dst  只同步 .md (排除 recovery/locks/缓存)
  mkdir -p "$2"
  rsync -a --delete -m --include='*/' --include='*.md' --exclude='*' "$1/" "$2/"
}

case "$MODE" in
pull)
  cp "$A/AGENTS.md" memory/AGENTS.md
  for f in MEMORY.md USER.md failures.md; do
    cp "$A/pi-hermes-memory/$f" "memory/$f"
  done
  sync_projects "$A/projects-memory" memory/projects
  sync_skills "$A/skills" memory/skills
  for f in memory/AGENTS.md memory/MEMORY.md memory/USER.md memory/failures.md \
           $(find memory/projects memory/skills -name '*.md' -o -name '*.sh' -o -name '*.py' 2>/dev/null); do
    scan_secrets "$f"
  done
  echo "[ok] pull 完成: 原则(AGENTS.md) 知识(MEMORY.md) 记忆(USER.md/failures.md/projects/skills) → memory/"
  git status -s memory/ | head -10
  ;;
push)
  for f in memory/AGENTS.md memory/MEMORY.md memory/USER.md memory/failures.md; do
    [ -f "$f" ] || { echo "缺少 $f" >&2; exit 1; }
    scan_secrets "$f"
  done
  cp memory/AGENTS.md "$A/AGENTS.md"
  mkdir -p "$A/pi-hermes-memory"
  for f in MEMORY.md USER.md failures.md; do cp "memory/$f" "$A/pi-hermes-memory/$f"; done
  sync_projects memory/projects "$A/projects-memory"
  # push 不用 --delete: 保护本机自管符号链接(~/.agents 等)与本地新增状态, 陈旧快照可接受
  sync_skills memory/skills "$A/skills"
  echo "[ok] push 完成: memory/ → ~/.pi/agent/"
  echo "[i] sessions.db 会话索引不迁移, hermes 启动后自动重建"
  ;;
*)
  echo "用法: $0 pull|push" >&2; exit 1 ;;
esac
