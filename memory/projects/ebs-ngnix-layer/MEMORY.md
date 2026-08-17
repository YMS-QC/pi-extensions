**ebs-nginx-gateway-status** — EBS 多应用反代网关（仓库 `/home/jimmy/repo/ebs-ngnix-layer`，OpenResty 路线，用户无 NGINX Plus License）。

- 测试机 `10.143.181.98`（主机名 cntl1320，RHEL 9.7，root，密码用户已在会话提供）。**无外网**：装包须本地下 RPM 再 scp（OpenResty 1.31.1.1 已装）。网关部署在 `/opt/gw`，监听 8080；mock 在 `/tmp/mock`（9000 假BTP/9001 假鉴权/9101/9102 粘性后端）。
- 测试环境 EBS：`cnebsdv.intranet.local -> F5 10.143.248.143:443/8035 -> 10.143.183.90:8019`（EBS 12.2，登录页 `/OA_HTML/AppsLocalLogin.jsp`，响应带 `X-ORACLE-DMS-ECID`）。
- 2026-06-10 已验证：阶段0 4/4（路由/302跳登录/internal保护/EBS_ROUTE 下发）、鉴权成功路径防伪造、JSESSIONID→XXBTP_SESSION 改名+Path收窄、粘性稳定、故障转移（曾有重试选同死节点的 bug，已修）、双网关一致性。本地单测 `lua5.1 test/lua_spec.lua` 22/22。
- 待外部依赖：EBS 侧开发 `xxbtpAuthCheck`（`ebs/` 有契约+Servlet骨架）；BTP 实际地址未知（gateway.conf 还指 mock 9000）；阶段2 要网络组改 F5 测试 VIP 后端池指向网关；真实登录态下复测 Cookie path 放宽（`proxy_cookie_path /OA_HTML /`）。
- 测试环境已接 **IDCS SSO**：`AppsLogin → e0asserter-dev.intranet.local:7050/ebs-cnebsdv/ssologin → IDCS(alticor 域, 可联邦 Amway Okta) OIDC 授权码`；`AppsLocalLogin.jsp` 仍可本地登录。Asserter 独立主机不经网关，方案评估后仍成立（设计文档 §5.2.1）；待验证点：SSO 后 `requestUrl` 深链接是否透传。
- BTP 未立项。测试机 mock 9000=调试单页、9001=demo 鉴权(带 EBS 会话类 Cookie 即放行)；网关 `_ebs_authcheck` **暂指 9001**（gateway.conf 有 TODO，真端点上线切回 `ebs_app`）。网关已加 `listen 443 ssl`（自签证书 `/opt/gw/c
…(迁移截断, 原文见 CC memory)
<!-- created=2026-08-16, last=2026-08-16 -->
