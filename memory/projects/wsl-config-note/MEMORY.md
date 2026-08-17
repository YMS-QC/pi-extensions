**claude-code-path-encoding** — Claude Code 的 `~/.claude/projects/` 目录按工作目录路径编码命名：`/` → `-`，**且 `_`（下划线）也归一化为 `-`**。

实证：真实目录 `/home/jimmy/repo/compare_oracleapex_and_reactjava`（带 3 个下划线）对应的编码目录是 `-home-jimmy-repo-compare-oracleapex-and-reactjava`（下划线全变连字符）。

**后果**：项目从 `private-repo` 改名成 `private_repo`（连字符→下划线）后，编码目录名相同（都是 `-home-jimmy-private-repo-*`），会话历史和 memory **完全连续**，无需迁移 `.claude/projects`。判据：新会话落到同编码目录即无感。注意 `history.jsonl` 的 `"project"` 字段是显示名（保留原样下划线），与存储目录名是两套，不矛盾。
<!-- created=2026-08-16, last=2026-08-16 -->
§
**wsl-config-note-privacy** — wsl-config-note（WSL 桌面配置交接文档）原始内容含公司可识别信息：机器名 `CNWSGZISDLV79`、全局 git 邮箱 `Jimmy.Xie@Amway.com`、`/mnt/c/amway/...` 路径等。

**Why:** 用户要求本仓库是"可参考的 private note"，不得含公司信息。首次归档已清理：README 删机器名、commit author 用个人邮箱 `quacimodoxz@gmail.com`（非全局 Amway 邮箱，需确认本仓库 commit 取的是它）。

**How to apply:** 本项目以后推送/分享/补充内容前，先 `grep -rniE "CNWSGZISDLV79|amway|Jimmy\.Xie|@amway"` 复核零命中再推。代理栈（sing-box/hysteria:1080）是个人配置非公司，private 仓库可留。仓库已推 private：https://github.com/YMS-QC/wsl-config-note。相关技术发现见项目 README 坑链；路径编码见 [[claude-code-path-encoding]]。
<!-- created=2026-08-16, last=2026-08-16 -->
§
**wsl-desktop-positioning** — 这台机器（Intel Core Ultra 5 228V，Arc 130V 集显）的 WSL 使用定位（2026-07-09 用户拍板）：

- **完整 Linux 桌面**：xrdp（display :10，软件渲染，无 GPU）。保留 xrdp，不换 X11 forwarding（xrdp 已是最优：RDP 比 X 协议高效，软件渲染绕不开）。
- **日常 GUI**（浏览器/办公/编辑器）：用 **Windows 原生**（Chrome/Edge/VS Code），不用 WSL 里的。Windows 原生直接用 Windows GPU，硬件加速充分。
- **WSL 的价值**：CLI / Linux 工具链 / 必须 Linux 的工具。不指望 WSL 的 GUI 体验。
- **GPU**：Arc 130V 是集显，支持 WSL d3d12（dxg 透传 OK），但 xrdp 软件渲染用不上；WSLg 单程序是唯一 GPU 通道但少用。GPU 对 WSL 桌面基本闲置。

**Why:** WSL 里折腾 GUI（xrdp 软件渲染 / GPU 终端 kitty/alacritty / WSL 浏览器 Falkon）体验注定不如 Windows 原生——软件渲染瓶颈绕不开，集显性能也有限。把 GUI 挪到 Windows，WSL 专注 CLI，UX 最佳，也最省事。

**How to apply:** 别再在 WSL 里优化 GUI 浏览器 / GPU 终端 / 桌面美化（plank 等 fancy dock 在 xrdp 还会 segfault）——收益低。xrdp 桌面只留给"必须完整 Linux 桌面"的场景，主力 GUI 走 Windows 原生。详见项目 README（YMS-QC/wsl-config-note）。关联 [[wsl-config-note-privacy]]、[[claude-code-path-encoding]]。
<!-- created=2026-08-16, last=2026-08-16 -->
