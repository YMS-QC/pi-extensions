#!/usr/bin/env bash
# deploy.sh — 把本 monorepo 的私有子包部署到 ~/.pi/agent/
# pi-agents      → ~/.pi/agent/agents/            (subagents 人格定义)
# pi-model-config→ ~/.pi/agent/extensions/model-config/  (/models 扩展)
# pi-config      → 原地运行 sync-models.py，不部署
set -euo pipefail
cd "$(dirname "$0")"
AGENT="$HOME/.pi/agent"

# 1. agents
mkdir -p "$AGENT/agents"
cp packages/pi-agents/*.md "$AGENT/agents/"
echo "[ok] agents → $AGENT/agents/ ($(ls packages/pi-agents/*.md | wc -l) 个)"

# 2. model-config 扩展
mkdir -p "$AGENT/extensions/model-config"
cp packages/pi-model-config/index.ts "$AGENT/extensions/model-config/"
echo "[ok] model-config → $AGENT/extensions/model-config/"

# 3. 提示（不自动执行）
echo "[i] pi-config: 需要渲染模型配置时手动运行 packages/pi-config/sync-models.py"
