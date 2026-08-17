**proxy-builder-repo** — 代理配置(服务端/本机/手机)已资产化为 GitHub 私有库:
**https://github.com/YMS-QC/proxy_builder**(账号 YMS-QC,PRIVATE;本地副本 `/home/jimmy/private_repo/proxy_builder`,分支 master)。

结构:`server/`(152 服务端模板 + systemd unit + 端口跳跃 + sysctl + `setup-152.sh`)、`client/`(本机 + 安卓 `.tpl` + `deploy-local.sh`/`switch-link.sh`)、`scripts/`(`render.sh` envsubst 注入 / `check.sh`)、`docs/`(架构/各端详解/踩坑手册/热点 TODO)、`.env.example`。

**值策略**(私有库当笔记,非公开):IP / 域名 / 端口 / 内网网段**已固化**进 `client/*.tpl`、`server/*.tpl`(真实值直接写);只有 4 个密码(SS2022/ShadowTLS/hy2-auth/hy2-obfs)走本地 `.env`(gitignore,不入库,会轮换),`render.sh` 用 envsubst 注入。

当前部署状态(详见 [[proxy-servers-infra]] / [[singbox-client-config]]):
- 本机(公司 WSL `CNWSGZISDLV79`)sing-box 已切 152 三活:selector **默认 `152-hy2`(Hysteria2,UDP,实测稳定+大文件快 ~3MB/s)**,`152-stls-ss`/`152-reality` 备用(免证书/某站 hy2 慢时切);`clash_api@127.0.0.1:9090` 热切。注:TCP 链路(stls/reality)到 CDN 大文件仅 KB/s,故 hy2 主力(见仓库 pitfalls#13)。手机仍 stls 主力(蜂窝掐 UDP)。
- 本机 mihomo 已卸(释放 9090 给 sing-box clash_api)。
- git 作者用 noreply 邮箱 `70993229+YMS-QC@users.noreply.github.com`(避免公司邮箱上 commit)。

后续优化(热点场景、新节点、调参)直接在仓库迭代。

**未做**:手机"能直连就直连"优化——sing-box 路由是静态规则、无 per-target 实时探测;gfw.srs 在 sing-geosite/MetaCubeX 常见源均 404 未找到稳定源,该需求搁置。
<!-- created=2026-08-16, last=2026-08-16 -->
§
**proxy-servers-infra** — 用户有两台 RackNerd VPS，SSH 用专用密钥 `~/.ssh/id_recnerd` 免密登录（root）：

- **152 = `root@107.175.94.152`**（主机 racknerd-5b22631，Ubuntu 24.04，2核2.4G）：跑 **claude-relay-service (CRS)** 于 `127.0.0.1:3000`（裸 node，未托管）、Redis，以及**双活代理**(详见 [[singbox-client-config]])：
  - **UDP 443 = Hysteria2 服务端**(`hysteria-server.service`，注意单元名是 hysteria-server 不是 hysteria)：obfs salamander、masquerade www.mozilla.org(证书 CN 同名)、端口跳跃 UDP 20000-40000→443(`hysteria-porthop.service`)、UDP buffer 16MB+BBR、auth/obfs 双密码。配置 `/etc/hysteria/`，有 `.bak.<ts>` 备份。
  - **TCP 443 = ShadowTLS v3 + Shadowsocks-2022**(`sing-box.service`，配置 `/etc/sing-box/config.json`)：借 www.apple.com 握手伪装、detour 链到内置 SS2022(2022-blake3-aes-128-gcm)。
  - **TCP 8443 = VLESS+Reality 备份**(`sing-box-reality.service`，独立实例，配置 `/etc/sing-box-reality/config.json`)：借 www.apple.com 免证书。**reality 实测可用**——当初"弃用"是客户端漏配 `tls.server_name` 的误判(issue #4023，非 sing-box bug)。keypair/uuid 在 .env(`REALITY_*`)。客户端 selector 第三选项 `152-reality`。
  - 注：sing-box.service 的 systemd Description 还残留旧的 "VLESS-REALITY (TCP443)" 字样，仅显示，无影响。

- **147 = `root@107.173.122.147`**（主机 racknerd-f0fa5e4，1核458M内存吃紧）：代理中转节点，跑 hysteria-server + hysteria-client + Cloudflare WARP；CRS 目录存在但**未运行**。用户明
…(迁移截断, 原文见 CC memory)
<!-- created=2026-08-16, last=2026-08-16 -->
§
**singbox-client-config** — 用户手机是 **sing-box 1.14.x (安卓, vivo/OriginOS)** 连 [[proxy-servers-infra]] 的 152 节点。

**最终架构 = 双活，两条腿都在 443**：
- **TCP 443 = ShadowTLS v3 + Shadowsocks-2022（主用、默认）**。借真实 `www.apple.com` 握手伪装(像 reality 但纯 sing-box 原生)，无需域名/证书。method `2022-blake3-aes-128-gcm`。客户端结构：`shadowsocks` 出站(tag 152-stls-ss) 经 `detour` 链到 `shadowtls` 出站(tag 152-stls, version 3, utls chrome, server_name www.apple.com)。**走 TCP，免疫运营商掐 UDP**——这是治"每14s断"的根。
- **UDP 443(+端口跳跃 20000-40000, hop_interval 10s) = Hysteria2**(obfs salamander, masquerade/server_name www.mozilla.org, insecure)。快但运营商会掐持续 UDP 流，作加速备选。
- 客户端用 `selector`(tag proxy, 默认 152-stls-ss) + `urltest`(tag auto, 测速切换 stls/hy2, interval 1m, interrupt_exist_connections)。route.final 与 dns proxydns.detour 与 rule_set.download_detour 全指向 `proxy`。
- 其余沿用：tun 入站；FakeIP(198.18/15) 国外域名秒回；split-DNS(geosite-cn→localdns 223.5.5.5，其余 A/AAAA→fakeip)；split-route(ip_is_private+geoip-cn/geosite-cn→direct)；route 必带 sniff+hijack-dns+quic reject；default_domain_resolver=proxydns；cache_file store_fakeip。

**reality 纠错 —— 实测可用(当初误判)**：
- 2026-07-09 loopback 实测：vless+reality 在 sing-box 客户端↔服务端**可用**(google generate_204 返回 204，reality 验证通过)。当初"reality 不可用、弃用换 ShadowTLS"是**误判**。
- 真
…(迁移截断, 原文见 CC memory)
<!-- created=2026-08-16, last=2026-08-16 -->
