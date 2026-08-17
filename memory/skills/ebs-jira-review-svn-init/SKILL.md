---
name: ebs-jira-review-svn-init
description: >-
  一次性初始化 WSL 端 SVN 工作副本：检查环境、写 OpenSSL 兼容配置、签出 Trident/xxamw、缓存凭据。用法：/skill:ebs-jira-review-svn-init [--dry-run]。触发词：SVN 初始化、签出 checkout。
metadata:
  source: jimmy-local/ebs-jira-review
  upstream: svn-init.md
---

> **pi 迁移版**（upstream: `svn-init.md` @ jimmy-local/ebs-jira-review）。共享资产：`~/.pi/agent/ebs-jira-review/`（`lib/`、`reference/`），配置仍用 `~/.ebs_jira_review.conf`。
> pi 约定：交互确认一律「输出预览/选项 → 文本提问 → 停下等用户回复」，未获答复不得继续后续步骤；认证类交互（svn 密码）提示用户在 agent 之外的终端手工执行。


<objective>
为 WSL 准备一个**与 Windows SVN 客户端双轨并行**的本地 SVN 工作副本，让后续 `/skill:ebs-jira-review-svn-update` 和 `/skill:ebs-jira-review-svn-commit` 能不靠 Windows 客户端独立工作：

1. 检查 `svn` CLI 已安装（未装则提示用户授权 `sudo apt install`）
2. 写 `~/.svn-openssl.cnf`（容忍 TLS 1.0/1.1 + 老 cipher，仅作用于 svn 命令，不影响系统）
3. 从 `EBS_SVN_USERNAME` / `EBS_SVN_PWD` **环境变量**读取凭据，跑一次 `svn checkout` 到 `~/svn/xxamw/`（WSL ext4，**不**放 /mnt/c）
4. 凭据缓存到 `~/.subversion/auth/`（之后日常命令免输密码）
5. 不向 `~/.ebs_jira_review.conf` 写任何密码字段（凭据全程不落盘）

**幂等设计**：已 checkout 的目录直接 `svn info` 跳过 checkout 步骤，安全可重复运行。
</objective>

<config>
`~/.ebs_jira_review.conf` 只放 URL 和本地路径，**不存任何凭据**：

```
JIRA_WORK_DIR=/mnt/c/Jira                  # 工作根目录（ticket / 附件 / 评审产物默认落这下面，Windows 端可见）
SVN_REPO_URL=https://...                   # SVN 远程 URL
SVN_LOCAL_PATH=/home/jimmy/svn/xxamw       # ⚠ SVN 工作副本**必须**放在 WSL 原生 ext4 上，不要放 /mnt/c
                                            # 原因：/mnt/c 走 v9fs，SQLite 锁语义不稳，wc.db 会 "database disk image is malformed"，
                                            #       svn cleanup 也救不回。Windows 端访问 SVN 改走单独的 C:\svn\xxamw\ 双轨。
# TICKET_BASE=/some/other/path             # 可选：覆盖 ticket 根目录（不设则 $JIRA_WORK_DIR/ticket）
```

**凭据走环境变量**（**只在启动 claude 之前**设置才能被读到）：

```bash
# 方式 A：进入 claude code 之前一次性注入（推荐）
EBS_SVN_USERNAME=CNU07LQ3 EBS_SVN_PWD='your-password' claude

# 方式 B：当前 shell 先 export，再启动 claude
export EBS_SVN_USERNAME=CNU07LQ3
export EBS_SVN_PWD='your-password'
claude
```

⚠ Claude 启动**之后**在另一个终端 `export` 不会被 Claude 进程看到 —— 必须在启动 claude 的同一个 shell 里、且在启动 claude 之前 export。

⚠ 一旦 SVN auth cache 已建立（首次 svn-init 成功后），日常 `svn-update` / `svn-commit` 不再需要这两个变量。它们只在两种情况下需要：
- 首次 svn-init 签出
- 服务器侧密码改了，cache 失效，需要重新认证
</config>

<process>

## Step 1 - 校验环境

```bash
DRY_RUN=0
for a in "$@"; do
  [ "$a" = "--dry-run" ] && DRY_RUN=1
done
[ "$DRY_RUN" = "1" ] && echo "🔍 DRY-RUN MODE — 不会写 OpenSSL conf / 不跑 svn checkout"

source ~/.ebs_jira_review.conf 2>/dev/null

JIRA_WORK_DIR="${JIRA_WORK_DIR:-/mnt/c/Jira}"
REPO_URL="$SVN_REPO_URL"
# 默认 SVN 工作副本落 WSL ext4（~/svn/xxamw），不落 /mnt/c。/mnt/c 上 SQLite 锁语义不稳，
# wc.db 会 "database disk image is malformed"。仅当 conf 显式设 SVN_LOCAL_PATH 才覆盖。
LOCAL_PATH="${SVN_LOCAL_PATH:-$HOME/svn/xxamw}"
USER_NAME="$EBS_SVN_USERNAME"
PASS_BOOT="$EBS_SVN_PWD"
# 早期防护：如果 LOCAL_PATH 落在 /mnt/c/* 给出强烈警告但不强制阻止（用户已显式设置）
if [[ "$LOCAL_PATH" == /mnt/c/* ]]; then
  echo "⚠ ⚠ ⚠ SVN_LOCAL_PATH 落在 /mnt/c（v9fs）：wc.db 极易损坏，强烈建议改到 /home/* 下的 ext4"
fi

# 1) svn CLI
if ! command -v svn >/dev/null 2>&1; then
  echo "✗ 未检测到 svn CLI"
  echo "  需要安装：sudo apt install -y subversion"
  # 文本提问: [安装 / 取消]（等待用户回复后分支）
  # 选"安装" → 执行 sudo apt install -y subversion
  # 选"取消" → exit 1
  exit 1
fi

# 2) 必填配置
if [ -z "$REPO_URL" ]; then
  echo "✗ ~/.ebs_jira_review.conf 缺 SVN_REPO_URL"
  exit 1
fi
```

## Step 1c - DRY-RUN 早退（如启用）

```bash
if [ "$DRY_RUN" = "1" ]; then
  HAS_WC=0; [ -d "$LOCAL_PATH/.svn" ] && HAS_WC=1
  HAS_CONF=0; [ -f "$HOME/.svn-openssl.cnf" ] && HAS_CONF=1
  HAS_PWD=0; [ -n "$PASS_BOOT" ] && HAS_PWD=1
  echo "──────────────────────────────────────────────"
  echo "[DRY-RUN] 计划"
  echo "  SVN URL:        $REPO_URL"
  echo "  本地路径:       $LOCAL_PATH (exists wc: $([ $HAS_WC = 1 ] && echo Y || echo N))"
  echo "  OpenSSL conf:   $HOME/.svn-openssl.cnf (exists: $([ $HAS_CONF = 1 ] && echo Y || echo N))"
  echo "  EBS_SVN_PWD:    $([ $HAS_PWD = 1 ] && echo "已设 → 走路径 B（自动）" || echo "未设 → 走路径 A（交互）")"
  echo ""
  echo "  将要执行（如非 dry-run）："
  [ $HAS_CONF = 0 ] && echo "    1. 写 ~/.svn-openssl.cnf（TLS 1.0 兼容）" || echo "    1. ~/.svn-openssl.cnf 已存在 → 跳过"
  if [ $HAS_WC = 1 ]; then
    echo "    2. 工作副本已存在 → 跳过 checkout"
  elif [ $HAS_PWD = 1 ]; then
    echo "    2. 走路径 B：svn checkout（密码进 ps -ef）"
  else
    echo "    2. 走路径 A：打印 WSL 终端命令让用户手工签出"
  fi
  echo "    3. 验证 ~/.subversion/auth/ 凭据缓存"
  echo "──────────────────────────────────────────────"
  exit 0
fi
```

## Step 2 - 写 OpenSSL 兼容配置（如不存在）

服务器证书过期 + 用老 TLS，全局放宽不安全；scoped 给 svn 用即可。

```bash
SSL_CONF="$HOME/.svn-openssl.cnf"
if [ ! -f "$SSL_CONF" ]; then
  cat > "$SSL_CONF" << 'EOF'
openssl_conf = openssl_init

[openssl_init]
ssl_conf = ssl_sect

[ssl_sect]
system_default = system_default_sect

[system_default_sect]
MinProtocol = TLSv1
CipherString = DEFAULT@SECLEVEL=0
Options = UnsafeLegacyRenegotiation
EOF
  chmod 600 "$SSL_CONF"
  echo "✔ 写入 $SSL_CONF（仅 svn 调用时引用，不影响系统其他进程）"
else
  echo "→ $SSL_CONF 已存在，跳过"
fi
```

**关键调用模板（后续 skills 都按这个写）**：

```bash
OPENSSL_CONF="$HOME/.svn-openssl.cnf" svn <subcmd> \
  --non-interactive \
  --trust-server-cert-failures "unknown-ca,cn-mismatch,expired,not-yet-valid,other" \
  [--username "$USER" --password "$PASS"]   # 仅在 auth cache 失效时追加
```

## Step 3 - 判断签出状态

```bash
if [ -d "$LOCAL_PATH/.svn" ]; then
  CUR_REV=$(OPENSSL_CONF="$HOME/.svn-openssl.cnf" svn info "$LOCAL_PATH" \
    --non-interactive \
    --trust-server-cert-failures "unknown-ca,cn-mismatch,expired,not-yet-valid,other" \
    2>/dev/null | awk -F': ' '/^版本: |^Revision: /{print $2; exit}')
  if [ -n "$CUR_REV" ]; then
    echo "→ $LOCAL_PATH 已是 svn 工作副本（当前 r$CUR_REV）"
    echo "  跳过 checkout，本命令无更多动作"
    SKIP_CHECKOUT=1
  fi
fi

if [ -z "$SKIP_CHECKOUT" ] && [ -e "$LOCAL_PATH" ] && [ ! -d "$LOCAL_PATH/.svn" ]; then
  echo "✗ $LOCAL_PATH 已存在但不是 svn 工作副本"
  echo "  请人工确认：要 mv $LOCAL_PATH ${LOCAL_PATH}.bak 后重新签出，还是中止？"
  # 文本提问: [备份后重签 | 中止]（等待用户回复后分支）
  exit 1
fi
```

## Step 4 - 首次 checkout（双路径选择）

签出走两条路径之一，**默认走 A（推荐：密码不进任何进程内/聊天）**：

### 路径 A — 交互式（推荐，密码完全不经过 claude）

如果 `EBS_SVN_PWD` **未设**，本命令**不自己跑 svn checkout**。改为打印一段命令让用户在 agent 之外的纯 WSL shell 里手工执行：

```bash
if [ -z "$SKIP_CHECKOUT" ] && [ -z "$PASS_BOOT" ]; then
  cat << EOF

══════════════════════════════════════════════
首次签出需要在 claude 之外完成（这样密码完全不经过 claude）

请打开一个新的 WSL 终端，把下面这条命令复制粘贴执行：

mkdir -p "$(dirname "$LOCAL_PATH")" && \\
OPENSSL_CONF=\$HOME/.svn-openssl.cnf svn checkout "$REPO_URL" "$LOCAL_PATH" --username ${USER_NAME:-CNU07LQ3}

⚠ **不要**加 \`--trust-server-cert-failures\` 和 \`--non-interactive\` —— 这两个 flag 是互斥的（svn 设计），加了反而会让 svn 拒绝交互。

执行时 svn 按顺序会问 3 个问题：
  1. (R)eject, accept (t)emporarily, accept (p)ermanently? → 输 **p** 回车（永久信任过期证书）
  2. "${USER_NAME:-CNU07LQ3}" 的密码:                          → 键盘输入（隐藏回显）回车
  3. 保存未加密的密码？(yes/no):                                → 输 **yes** 回车

跑完之后回来跟我说"签好了"，我会接着验证缓存 + 收尾。
══════════════════════════════════════════════
EOF
  exit 0
fi
```

### 路径 B — env-var 自动签出（密码会进 ps -ef，仅当用户明确 export 了 EBS_SVN_PWD 时走）

```bash
if [ -z "$SKIP_CHECKOUT" ] && [ -n "$PASS_BOOT" ]; then
  echo "→ 检测到 EBS_SVN_PWD 已设置，走自动签出路径"
  echo "  ⚠ 注意：svn checkout 的 --password 参数对 ps -ef 可见（单用户 WSL 风险可接受）"
  mkdir -p "$(dirname "$LOCAL_PATH")"

  OPENSSL_CONF="$HOME/.svn-openssl.cnf" svn checkout "$REPO_URL" "$LOCAL_PATH" \
    --username "$USER_NAME" --password "$PASS_BOOT" \
    --non-interactive \
    --trust-server-cert-failures "unknown-ca,cn-mismatch,expired,not-yet-valid,other" \
    2>&1 | tail -20

  if [ ! -d "$LOCAL_PATH/.svn" ]; then
    echo "✗ checkout 失败"
    exit 1
  fi

  CHECKOUT_REV=$(OPENSSL_CONF="$HOME/.svn-openssl.cnf" svn info "$LOCAL_PATH" \
    --non-interactive \
    --trust-server-cert-failures "unknown-ca,cn-mismatch,expired,not-yet-valid,other" \
    | awk -F': ' '/^版本: |^Revision: /{print $2; exit}')
  echo "✔ checkout 完成，本地 r$CHECKOUT_REV"
fi
```

### 路径选择规则

| 条件 | 走的路径 | 行为 |
|---|---|---|
| `LOCAL_PATH/.svn` 已存在 | 跳过 checkout | 直接进 Step 5 |
| `EBS_SVN_PWD` 未设 | 路径 A | 打印交互命令，**退出**等用户手工跑 |
| `EBS_SVN_PWD` 已设 | 路径 B | 自动签出（接受 ps 暴露） |

**核心原则**：默认让用户保留对密码的全程控制权；只有用户明确通过 env var 授权时才走自动路径。

## Step 5 - 验证凭据已缓存

```bash
AUTH_CACHE_DIR="$HOME/.subversion/auth"
CACHE_FILES=$(find "$AUTH_CACHE_DIR" -type f 2>/dev/null | wc -l)
if [ "$CACHE_FILES" -gt 0 ]; then
  echo "✔ SVN 凭据已缓存（$AUTH_CACHE_DIR，$CACHE_FILES 个文件）"
  echo "  日常 svn-update / svn-commit 无需再设 EBS_SVN_PWD"
else
  echo "⚠ 未发现凭据缓存（可能你的 SVN 配置 store-passwords=no）"
  echo "  之后 svn-update / svn-commit 失败时，请重启 claude 并设置环境变量重试"
fi
```

## Step 6 - 末尾输出 + 使用提示

```
──────────────────────────────────────────────
✔ SVN 工作副本就绪

仓库 URL:  {SVN_REPO_URL}
本地路径:  {LOCAL_PATH}
当前版本:  r{CHECKOUT_REV}
凭据缓存:  ~/.subversion/auth/   ← 日常命令自动使用

⚠ 凭据安全：
- 本命令未向 ~/.ebs_jira_review.conf 写任何密码
- 走的是 {路径 A 交互式 / 路径 B env-var}（根据 Step 4 实际选择填写）
- 如缓存失效（修改密码/换机器），重新跑本命令即可，默认走路径 A 不需要 export 任何变量

下一步：
  /skill:ebs-jira-review-svn-update              # 把本地基线刷到最新（review 前必跑）
  /skill:ebs-jira-review-review TE-XXXX          # 走评审流程
  /skill:ebs-jira-review-svn-commit TE-XXXX      # 评审通过后提交并回写 Migration
──────────────────────────────────────────────
```

</process>

<notes>
- **本命令是幂等的**：重复跑只会跳过已完成的步骤，不会重复 checkout
- **首次签出耗时**：xxamw 整层（含 18 个子目录、几千文件）大约 5–20 分钟，视网络
- **凭据来源**：默认走路径 A（claude 外交互式输入，密码不进 ps、不进 claude 进程、不进 chat）；用户主动 export `EBS_SVN_USERNAME` / `EBS_SVN_PWD` 才走路径 B（自动 + ps 可见）。两路径都最终落到 SVN auth cache（~/.subversion/auth/）
- **conf 永远不存密码**：无论走 A 还是 B，~/.ebs_jira_review.conf 都只放 URL 和本地路径
- **TLS 兼容配置**只通过 `OPENSSL_CONF=~/.svn-openssl.cnf` 注入到 svn 进程，**不影响系统 curl/openssl/Python**。这是因为 OpenSSL lib 在初始化时读 `OPENSSL_CONF` 这个 env，不读则用系统默认 `/etc/ssl/openssl.cnf`
- **证书 trust failures** 使用 `--trust-server-cert-failures "unknown-ca,cn-mismatch,expired,not-yet-valid,other"`：
  - `unknown-ca`：私有 CA 未导入系统信任库
  - `expired`：服务器证书已过期（cnnt034 的实际状态）
  - `cn-mismatch` / `not-yet-valid` / `other`：兜底，避免下次再踩
- **不写 `~/.subversion/servers` 全局 trust**：scoped 到本命令更可控；用户其它 svn 客户端不受影响
- **WSL ↔ Windows 的 SVN 客户端互不干扰**：Windows 用 `C:\svn\xxamw\`，WSL 用 `~/svn/xxamw/`（WSL ext4），两套 `.svn/` 元数据独立。同一个文件**不要在两边同时改**，否则会出现版本冲突。**早期版本曾把 WSL 工作副本放 `/mnt/c/Jira/svn/`，因 v9fs 上 SQLite 锁不稳导致 wc.db 频繁损坏，已迁移到 `~/svn/xxamw/`**
- **历史 commit 的作者归属**：基于环境变量 `EBS_SVN_USERNAME`（如 CNU07LQ3）；svn ci 时这个 username 会成为 commit author 字段
</notes>
