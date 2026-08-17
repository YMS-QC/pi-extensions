#!/usr/bin/env bash
# update-vendors.sh — 从上游直接 subtree pull 同步收纳包（无需 fork 仓）
# 我们的补丁是 subtree 历史上的本地提交，merge 语义保留；冲突则中止提示手工处理
# 之后: push && pi update --extensions
set -uo pipefail
cd "$(dirname "$0")"

declare -A VENDORS=(
  [pi-telegram]="up-telegram main"
  [pi-automode]="up-automode main"
  [pi-hermes-memory]="up-hermes main"
)

updated=0
failed=0
for pkg in "${!VENDORS[@]}"; do
  echo "=== $pkg"
  read -r remote branch <<< "${VENDORS[$pkg]}"
  git fetch "$remote" --quiet 2>/dev/null || { echo "  [skip] fetch $remote 失败"; failed=$((failed+1)); continue; }
  out="$(git subtree pull --prefix=packages/stack/$pkg "$remote" "$branch" -m "subtree: sync $pkg from $remote/$branch" 2>&1)"
  if [ $? -ne 0 ]; then
    git merge --abort 2>/dev/null
    echo "  [fail] 冲突/失败已中止，手工处理: git subtree pull --prefix=packages/stack/$pkg $remote $branch"
    echo "$out" | sed 's/^/    /' | head -5
    failed=$((failed+1)); continue
  fi
  if echo "$out" | grep -qi "already up to date"; then
    echo "  [ok] 已是最新"
  else
    echo "  [ok] 已同步"; updated=$((updated+1))
  fi
done

if [ $updated -gt 0 ]; then
  git push --quiet 2>/dev/null && echo "已推送 origin/main" || echo "[warn] push 失败，请手工 push"
  echo "提示: 运行 pi update --extensions 同步运行时副本"
fi
echo "结果: 同步 $updated, 失败 $failed"
exit $((failed > 0 ? 1 : 0))
