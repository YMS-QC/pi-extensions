**wxfh-architecture** — Tool目标: 本地 agent-browser 工具，监控微信网页版「文件传输助手」(https://filehelper.weixin.qq.com/)，拉二维码登录后抓取发送的消息/文件。

关键事实（实地侦察 2026-06-28 得到）:
- 登录走标准 webwx 协议: `jslogin?appid=wx_webfilehelper` 拿 uuid → 二维码是 `<img class="qrcode-img" src="https://login.weixin.qq.com/qrcode/<uuid>">`(公开可直接下载) → JSONP 长轮询 `login.wx.qq.com/.../login?uuid=...` 返回 window.code(408待扫/201已扫/200确认) → `webwxinit` → `webwxsync` 长轮询收新消息。
- 抓消息用**注入 XHR/fetch 钩子**截获页面自身的 `webwxinit`/`webwxsync` JSON 响应(AddMsgList)，比抓 DOM 稳。登录检测=钩子收到 webwxinit。
- agent-browser `--profile <dir>` 持久化登录态，但**只在首次启动 daemon 时生效**，daemon 已运行时该 flag 被忽略(有 ⚠ 警告)。所以 login/open 负责带 profile 启动 daemon，其余命令复用。
- profile 路径 ~/.wechat-filehelper/profile, session 名 wxfh, 数据在 repo ./data (gitignore)。

MsgType: 1=text 3=image 34=voice 43=video 47=emoji 49=file/appmsg 10000=system。
文件字节下载需登录态 DOM/ticket，v1 只抓 文件名/大小 元数据。

后续进展(2026-06-28):
- 二维码可在**终端渲染**(qrcode-terminal, small模式)。QR 编码内容就是 `https://login.weixin.qq.com/l/<uuid>`(zbarimg 解码确认)，从 qrSrc 派生即可，无需运行时解码。
- 新增 send/send-file: agent→微信。"发JSON时发送按钮变灰点不动" 的真因是**输入框是受控组件、手动粘贴没触发 input 事件→按钮 disabled**，不是微信内容拦截。解法: agent-browser `fill` 走 CDP 会触发 input 事件让按钮启用; 发送要**点"发送"按钮**而非按 Enter(否则多行被拆条)。已用模拟受控按钮的测试页验证。多行换行会
…(迁移截断, 原文见 CC memory)
<!-- created=2026-08-16, last=2026-08-16 -->
