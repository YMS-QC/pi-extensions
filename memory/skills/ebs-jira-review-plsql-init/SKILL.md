---
name: ebs-jira-review-plsql-init
description: >-
  安装 PL/SQL 子模块依赖（npm install）并验证 DB 连接。首次使用 PL/SQL 上下文能力前跑一次。用法：/skill:ebs-jira-review-plsql-init [env]。触发词：plsql 初始化。
metadata:
  source: jimmy-local/ebs-jira-review
  upstream: plsql-init.md
---

> **pi 迁移版**（upstream: `plsql-init.md` @ jimmy-local/ebs-jira-review）。共享资产：`~/.pi/agent/ebs-jira-review/`（`lib/`、`reference/`），配置仍用 `~/.ebs_jira_review.conf`。
> pi 约定：交互确认一律「输出预览/选项 → 文本提问 → 停下等用户回复」，未获答复不得继续后续步骤；认证类交互（svn 密码）提示用户在 agent 之外的终端手工执行。


<objective>
一次性初始化 plugin 内嵌的 PL/SQL nodejs 子模块（`lib/plsql/`）：

1. 验证 node / npm 可用
2. 在 `lib/plsql/` 目录跑 `npm install`（装 oracledb 与 commander）
3. 验证 amway PL/SQL downloader config 目录可访问
4. 用 `node cli.js test-connection --env $ENV` 实际跑一次 `select 1 from dual` 验证数据库可达
5. 失败 → 打印明确的修复指引（缺 instantclient / config 路径错 / VPN 未连 等）

设计原则：可重复跑，已装则跳过安装，但每次都重新测连接。
</objective>

<args>
- **env**（可选）：`dev|qa|pd`；不传则用 `EBSJR_PLSQL_DEFAULT_ENV`（默认 `dev`）
</args>

<config>
读 `~/.ebs_jira_review.conf`：
- `EBSJR_PLSQL_AMWAY_CONFIG_DIR`：amway 项目根（必须存在，取 `config/config.{env}.json`）
- `EBSJR_PLSQL_DEFAULT_ENV`：默认环境
</config>

<process>

## Step 1 - 解析参数 + 找 plugin lib 路径

```bash
. ~/.ebs_jira_review.conf
. ~/.pi/agent/ebs-jira-review/lib/jira_helpers.sh

ENV=$(echo "$ARGUMENTS" | grep -oiE '\bdev\b|\bqa\b|\bpd\b' | head -1 | tr 'A-Z' 'a-z')
ENV="${ENV:-${EBSJR_PLSQL_DEFAULT_ENV:-dev}}"
case "$ENV" in
  dev|qa|pd) : ;;
  *) echo "✗ env 必须是 dev|qa|pd，得到 '$ENV'"; exit 1 ;;
esac

PLUGIN_LIB=$(dirname "$(ebsjr_plsql_cli_path)")
echo "── plsql-init ──"
echo "  Env:               $ENV"
echo "  Plugin lib/plsql:  $PLUGIN_LIB"
echo "  Amway config dir:  ${EBSJR_PLSQL_AMWAY_CONFIG_DIR:-/mnt/c/amway_repo/plsql}"
echo ""
```

## Step 2 - 检查 node / npm

```bash
node -v >/dev/null 2>&1 || { echo "✗ 找不到 node — 请先装 Node.js >= 14"; exit 1; }
npm -v  >/dev/null 2>&1 || { echo "✗ 找不到 npm"; exit 1; }
echo "✔ node $(node -v) / npm $(npm -v)"
```

## Step 3 - 检查 amway config 目录

```bash
CFG_DIR="${EBSJR_PLSQL_AMWAY_CONFIG_DIR:-/mnt/c/amway_repo/plsql}"
CFG_FILE="$CFG_DIR/config/config.${ENV}.json"

if [ ! -d "$CFG_DIR" ]; then
  echo "✗ amway 项目目录不存在：$CFG_DIR"
  echo "  设置 ~/.ebs_jira_review.conf 的 EBSJR_PLSQL_AMWAY_CONFIG_DIR，或者："
  echo "    git clone <amway-plsql-repo> $CFG_DIR"
  exit 1
fi
if [ ! -f "$CFG_FILE" ]; then
  echo "✗ amway DB config 缺失：$CFG_FILE"
  echo "  在 amway 项目 config/ 下放好 config.${ENV}.json"
  exit 1
fi
# 不打印密码；仅校验关键字段存在
node -e "
  const c = require('$CFG_FILE');
  if (!c.database || !c.database.user || !c.database.password || !c.database.connectionString) {
    console.error('✗ config.${ENV}.json 缺少 database.user/password/connectionString 字段');
    process.exit(1);
  }
  console.log('✔ amway DB config 字段完整 (user=' + c.database.user + ')');
"
```

## Step 4 - npm install（已装则跳过）

```bash
if [ -d "$PLUGIN_LIB/node_modules/oracledb" ]; then
  echo "ℹ node_modules 已存在，跳过安装"
else
  echo "→ cd $PLUGIN_LIB && npm install"
  (cd "$PLUGIN_LIB" && npm install --silent --no-audit --no-fund) || {
    echo "✗ npm install 失败"
    echo "  常见原因：node-gyp 编译 oracledb native 模块需要 python / make"
    echo "  Ubuntu/WSL：sudo apt install -y python3 build-essential"
    exit 1
  }
  echo "✔ npm install OK"
fi
```

## Step 4b - 写 sqlnet.ora（WSL/NAT 环境必备）

WSL2/防火墙环境下 Oracle SQL*Net 的 Out-Of-Band (OOB) breaks 经常被吞掉，导致连接握手以 `ORA-12637 Packet receive failed` 失败。`DISABLE_OOB=ON` 解决。

`SQLNET.AUTHENTICATION_SERVICES=(NONE)` 关闭 NTS（Windows native auth），强制纯密码认证。

```bash
if [ -n "${EBSJR_PLSQL_LIBDIR:-}" ] && [ -d "$EBSJR_PLSQL_LIBDIR" ]; then
  SQLNET_DIR="$EBSJR_PLSQL_LIBDIR/network/admin"
  mkdir -p "$SQLNET_DIR"
  SQLNET_FILE="$SQLNET_DIR/sqlnet.ora"
  if [ ! -f "$SQLNET_FILE" ] || ! grep -q "DISABLE_OOB" "$SQLNET_FILE"; then
    cat > "$SQLNET_FILE" <<'EOF'
SQLNET.AUTHENTICATION_SERVICES=(NONE)
DISABLE_OOB=ON
EOF
    echo "✔ 写入 $SQLNET_FILE"
  else
    echo "ℹ sqlnet.ora 已配置 DISABLE_OOB，跳过"
  fi
fi
```

## Step 5 - 验证 Oracle instantclient

`oracledb` 默认 thin 模式不支持 EBS 数据库（需要 thick），thick 模式依赖 instantclient。amway config 的 `libDir` 字段指明 instantclient 路径。

```bash
LIB_DIR=$(node -e "console.log(require('$CFG_FILE').database.libDir || '')")
if [ -z "$LIB_DIR" ]; then
  echo "⚠ amway config 未配 libDir — oracledb 将走 thin 模式（EBS 12.2 数据库可能不支持）"
elif [ ! -d "$LIB_DIR" ]; then
  echo "✗ instantclient libDir 路径不存在：$LIB_DIR"
  echo "  下载 Oracle Instant Client basic 包，解压到该路径，或改 amway config"
  exit 1
else
  echo "✔ instantclient libDir: $LIB_DIR"
fi
```

## Step 6 - 实测连接（select 1 from dual）

```bash
echo ""
echo "── 测试 DB 连接（env=$ENV）──"
OUT=$(EBSJR_PLSQL_DEFAULT_ENV="$ENV" \
      EBSJR_PLSQL_AMWAY_CONFIG_DIR="$CFG_DIR" \
      node "$PLUGIN_LIB/cli.js" test-connection --env "$ENV" 2>&1)
RC=$?
if [ "$RC" = "0" ]; then
  echo "$OUT"
  echo "✔ DB 连接 OK"
else
  echo "$OUT"
  echo ""
  case "$RC" in
    3) echo "✗ DB 不可达（exit 3）—— 排查：VPN？防火墙？config.${ENV}.json 的 connectionString？" ;;
    *) echo "✗ DB 测试失败 RC=$RC" ;;
  esac
  exit "$RC"
fi
```

## Step 7 - 完工提示

```bash
echo ""
echo "✔ plsql-init 完成"
echo "  下一步：跑 /skill:ebs-jira-review-plsql-refresh TE-XXXX [env] 把 ticket 涉及对象拉到本地"
echo "  或者直接跑 /skill:ebs-jira-review-review TE-XXXX，评审会自动调"
```

</process>

<failure_modes>

| 失败 | 现象 | 处理 |
|---|---|---|
| node / npm 未装 | command not found | 装 Node.js >= 14 |
| amway config 目录错 | Step 3 报路径不存在 | 改 conf 的 `EBSJR_PLSQL_AMWAY_CONFIG_DIR` |
| amway config 缺 database 字段 | Step 3 校验失败 | 修 amway 的 `config/config.{env}.json` |
| npm install 失败（oracledb native build） | Step 4 报错 | `sudo apt install -y python3 build-essential` |
| instantclient libDir 不存在 | Step 5 报错 | 下载 Oracle Instant Client basic，解压到指定路径 |
| ORA-12541/12170（DB 不可达） | Step 6 exit=3 | 检查 VPN / 防火墙 / connectionString |
| ORA-01017（认证失败） | Step 6 exit=1 | 检查 amway config 的 user/password |
</failure_modes>
