**svn-bashrc-legacy-ssl-wrapper** — 裸 `svn update`（不经 skill）连 `cnnt034` 报 `E120171 SSL communication`，因为服务器只支持 TLS 1.0 + 弱 cipher，OpenSSL 3.0 默认拒绝。详见 [[ebs-svn-openssl-legacy-config]]。

**已做的持久修复**：`~/.bashrc` 末尾加了 svn 包装函数（2026-06-24，用户手动执行写入）：
```bash
svn() { [ -t 2 ] && echo "⚠ svn 已套用 legacy SSL 配置 (~/.svn-openssl.cnf)" >&2; OPENSSL_CONF="$HOME/.svn-openssl.cnf" command svn "$@"; }
```

**Why**：只对 svn 注入 `OPENSSL_CONF=~/.svn-openssl.cnf`，不全局降 TLS 安全级。`[ -t 2 ]` 保证只在交互终端打印提示，skill `/ebs-jira-review:svn-update` 用 `2>&1` 管道抓取时不打印、不污染 revision 解析。

**How to apply**：若裸 svn 又报 SSL 错，先确认 `~/.svn-openssl.cnf` 在且 `~/.bashrc` 的 svn() 函数已加载（`type svn`）。改 `~/.bashrc` 会被 auto-mode 权限拦，需让用户自己用 `! ...` 执行。
<!-- created=2026-08-16, last=2026-08-16 -->
