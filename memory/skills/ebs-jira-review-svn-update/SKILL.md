---
name: ebs-jira-review-svn-update
description: >-
  把本地 SVN 工作副本同步到最新（svn update），打印前后 revision 与变化摘要。review 前调用保证 diff 基于最新基线。用法：/skill:ebs-jira-review-svn-update [--dry-run]。触发词：SVN 更新、svn update、刷基线。
metadata:
  source: jimmy-local/ebs-jira-review
  upstream: svn-update.md
---

> **pi 迁移版**（upstream: `svn-update.md` @ jimmy-local/ebs-jira-review）。共享资产：`~/.pi/agent/ebs-jira-review/`（`lib/`、`reference/`），配置仍用 `~/.ebs_jira_review.conf`。
> pi 约定：交互确认一律「输出预览/选项 → 文本提问 → 停下等用户回复」，未获答复不得继续后续步骤；认证类交互（svn 密码）提示用户在 agent 之外的终端手工执行。


<objective>
对 `~/svn/xxamw/` 跑 `svn update`，让本地基线对齐 repo HEAD：

1. 跑前打印当前 revision
2. 执行 update
3. 打印目标 revision 和本次同步带入的文件清单（A/U/D/G/C 标记）
4. 如果有冲突（C 标记）→ **立刻报错并停下**，不让后续 review/commit 在脏基线上跑
5. 把同步信息写入临时摘要 `/tmp/svn_update_summary.txt`，供 `/skill:ebs-jira-review-review` 读取并写进 design.md

设计原则：**只同步，不改任何工作副本以外的东西**。失败安全，可重复运行。
</objective>

<config>
读 `~/.ebs_jira_review.conf` 的 `SVN_LOCAL_PATH`（默认 `~/svn/xxamw`，WSL ext4；**不要**把工作副本放 /mnt/c —— v9fs 下 SQLite 锁不稳，wc.db 会出 "database disk image is malformed"）。

**凭据策略**：
- 默认走 SVN auth cache（~/.subversion/auth/）
- 如缓存失效（如服务器侧改了密码）→ 本命令**不在 agent 内自动重新认证**，而是**停下并指导用户在 WSL 终端里手工跑 svn 重认证**。理由：agent 子进程没有 TTY，svn 无法弹密码提示；任何"自动"路径要么挂起、要么把密码放进命令行（ps -ef 可见）、要么把密码送进 chat。让用户在 agent 之外用 /dev/tty 输密码是唯一既能完成认证又不暴露密码的路径
</config>

<process>

## Step 1 - 校验环境

```bash
DRY_RUN=0
for a in "$@"; do
  [ "$a" = "--dry-run" ] && DRY_RUN=1
done
[ "$DRY_RUN" = "1" ] && echo "🔍 DRY-RUN MODE — 不会跑 svn update"

source ~/.ebs_jira_review.conf 2>/dev/null
JIRA_WORK_DIR="${JIRA_WORK_DIR:-/mnt/c/Jira}"
# SVN 工作副本默认 WSL ext4（~/svn/xxamw），不落 /mnt/c。/mnt/c 的 v9fs SQLite 锁不稳，wc.db 易损坏。
LOCAL_PATH="${SVN_LOCAL_PATH:-$HOME/svn/xxamw}"

if [ ! -d "$LOCAL_PATH/.svn" ]; then
  echo "✗ $LOCAL_PATH 不是 svn 工作副本"
  echo "  请先跑 /skill:ebs-jira-review-svn-init 完成首次签出"
  exit 1
fi

if ! command -v svn >/dev/null 2>&1; then
  echo "✗ svn CLI 未安装；跑 /skill:ebs-jira-review-svn-init 时会引导安装"
  exit 1
fi

SSL_CONF="$HOME/.svn-openssl.cnf"
if [ ! -f "$SSL_CONF" ]; then
  echo "✗ 缺 $SSL_CONF；跑 /skill:ebs-jira-review-svn-init 会自动创建"
  exit 1
fi
```

## Step 2 - 定义 svn 调用 + auth 失效处理

```bash
# 唯一调用方式：使用 cache（不传 username/password）
svn_run() {
  OPENSSL_CONF="$SSL_CONF" svn "$@" \
    --non-interactive \
    --trust-server-cert-failures "unknown-ca,cn-mismatch,expired,not-yet-valid,other"
}

# auth 失败时：打印交互式重认证指引，退出（不自动 fallback）
abort_with_auth_guidance() {
  cat << EOF

══════════════════════════════════════════════
✗ SVN auth cache 已失效（服务器侧密码可能改了，或 cache 损坏）

要重新认证，请在 **claude 之外的 WSL 终端**里跑下面这条命令（密码全程不经过 agent）：

OPENSSL_CONF=\$HOME/.svn-openssl.cnf svn update "$LOCAL_PATH" --username CNU07LQ3

⚠ **不要**加 \`--trust-server-cert-failures\` 和 \`--non-interactive\` —— 这两个 flag 是互斥的（svn 设计），加了反而会让 svn 拒绝交互。

执行时 svn 按顺序会问 3 个问题：
  1. (R)eject, accept (t)emporarily, accept (p)ermanently? → 输 **p** 回车（永久信任过期证书）
  2. "CNU07LQ3" 的密码:                                    → 键盘输入新密码（隐藏回显）
  3. 保存未加密的密码？(yes/no):                            → 输 **yes** 回车

完成后 cert + 密码都进 ~/.subversion/auth/ 缓存，回到 agent 重跑 /skill:ebs-jira-review-svn-update 就能走 cache 了。

为什么不在 claude 里自动处理？
  - agent 的 bash 子进程没有 TTY，svn 没法弹密码提示
  - 走命令行 --password 会让密码出现在 ps -ef 输出里
  - 让你在 /dev/tty 上手工输入是唯一既能认证又不暴露密码的路径
══════════════════════════════════════════════
EOF
  exit 1
}
```

## Step 2c - DRY-RUN 早退（如启用）

```bash
if [ "$DRY_RUN" = "1" ]; then
  CUR_REV=$(svn_run info "$LOCAL_PATH" 2>/dev/null | awk -F': ' '/^Revision: |^版本: /{print $2; exit}')
  echo "──────────────────────────────────────────────"
  echo "[DRY-RUN] 计划"
  echo "  本地副本:  $LOCAL_PATH（当前 r${CUR_REV:-?}）"
  echo ""
  echo "  将要执行（如非 dry-run）："
  echo "    svn update $LOCAL_PATH"
  echo "    → 解析输出 A/U/D/G/C 标记"
  echo "    → 写 /tmp/svn_update_summary.txt"
  echo "──────────────────────────────────────────────"
  exit 0
fi
```

## Step 3 - 拿当前 revision

```bash
INFO_OUT=$(svn_run info "$LOCAL_PATH" 2>&1)
if echo "$INFO_OUT" | grep -qE "E215004|E170001|authentication"; then
  abort_with_auth_guidance
fi
BEFORE_REV=$(echo "$INFO_OUT" | awk -F': ' '/^版本: |^Revision: /{print $2; exit}')
echo "→ 同步前本地版本: r${BEFORE_REV}"
```

## Step 4 - 执行 update

```bash
echo "→ 执行 svn update ..."
UPDATE_OUT=$(svn_run update "$LOCAL_PATH" 2>&1)

# auth 失效 → 不自动 fallback，提示用户手工重认证
if echo "$UPDATE_OUT" | grep -qE "E215004|E170001|authentication"; then
  abort_with_auth_guidance
fi

echo "$UPDATE_OUT"
```

## Step 5 - 解析结果，检测冲突

`svn update` 输出的状态字母（行首前 5 列）：

| 标记 | 含义 | 处理 |
| --- | --- | --- |
| `A` | Added 新增文件 | 正常 |
| `D` | Deleted 删除 | 正常 |
| `U` | Updated 内容更新 | 正常 |
| `G` | Merged 自动合并成功 | 正常 |
| `C` | **Conflict 冲突** | **必须人工解决，本命令报错退出** |
| `E` | Existed 已存在 | 正常 |

```bash
CONFLICT_LINES=$(echo "$UPDATE_OUT" | grep -E "^C  |^ C |^CC")
if [ -n "$CONFLICT_LINES" ]; then
  echo ""
  echo "✗ 检测到冲突文件，必须人工解决后才能继续："
  echo "$CONFLICT_LINES"
  echo ""
  echo "  解决步骤："
  echo "    1. 用 Windows SVN 客户端 或 svn resolve 处理冲突"
  echo "    2. 处理完毕后重跑此命令确认无 C 标记"
  exit 1
fi
```

## Step 6 - 拿目标 revision + 生成摘要

```bash
AFTER_REV=$(svn_run info "$LOCAL_PATH" | awk -F': ' '/^版本: |^Revision: /{print $2; exit}')

CHANGED_FILES=$(echo "$UPDATE_OUT" | grep -E "^[ADUGE]  " | sed 's/^.....//' | head -50)
CHANGED_COUNT=$(echo "$UPDATE_OUT" | grep -cE "^[ADUGE]  ")

# 写到 review skill 会读的位置
SUMMARY=/tmp/svn_update_summary.txt
{
  echo "before_revision=$BEFORE_REV"
  echo "after_revision=$AFTER_REV"
  echo "changed_count=$CHANGED_COUNT"
  echo "synced_at=$(date '+%Y-%m-%d %H:%M:%S')"
  echo "---changed_files---"
  echo "$CHANGED_FILES"
} > "$SUMMARY"

echo ""
echo "──────────────────────────────────────────────"
if [ "$BEFORE_REV" = "$AFTER_REV" ]; then
  echo "✔ 已是最新（r${AFTER_REV}），无新增改动"
else
  echo "✔ 同步完成：r${BEFORE_REV} → r${AFTER_REV}（$CHANGED_COUNT 个文件变化）"
  if [ "$CHANGED_COUNT" -le 20 ] && [ -n "$CHANGED_FILES" ]; then
    echo ""
    echo "本次同步带入的文件："
    echo "$CHANGED_FILES" | sed 's/^/  /'
  fi
fi
echo "摘要已写入：$SUMMARY  （review skill 会自动读取）"
echo "──────────────────────────────────────────────"
```

## Step 7 - 错误兜底

| 状况 | 处理 |
| --- | --- |
| 工作副本不存在 | 提示先跑 svn-init |
| svn CLI 未装 | 提示先跑 svn-init |
| OpenSSL 配置缺失 | 提示先跑 svn-init |
| auth cache 失效 | 打印 WSL 终端交互重认证命令，exit 1，等用户在 agent 外完成认证后回来重跑 |
| 检测到 C 冲突 | 报错退出，给出人工解决步骤 |
| 网络/服务器不可达 | svn 自身错误信息直接打印，exit 1 |

</process>

<notes>
- **本命令只读 + 写工作副本**，不动任何用户配置，纯查询+同步操作；可放心重复运行
- **`/tmp/svn_update_summary.txt` 是与 review skill 的契约文件**：review 在 Step 1 之前会读这个摘要并写进 design.md 的"基线版本"小节。如果摘要不存在或时间戳超过 1 小时，review skill 会自动重跑本命令
- **冲突 (C) 必须人工解决**：自动 `svn resolve --accept theirs/mine` 太危险，会丢工作。一旦出现 C，本命令立即停止，让用户在 Windows 客户端或手动用 svn 命令处理
- **auth 失效不自动 fallback**：cache 失效时打印 WSL 终端命令让用户手工重认证，密码全程不经过 agent。这是与早期设计（fallback 到 EBS_SVN_PWD env var）的区别，理由：env var 路径会导致 svn 命令把 `--password xxx` 放到 ps -ef 上，单用户 WSL 风险虽小但非零
- 同步前后 revision 一致 → 早退；不要硬塞"无变化"的清单到 design.md 里制造噪音
</notes>
