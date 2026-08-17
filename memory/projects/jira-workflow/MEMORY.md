**btp-trident-jira-auth-perms** — 两套 Jira 凭证在 `/home/jimmy/.com-jira-key/`，账号均为 Jimmy Xie(Jimmy.Xie@Amway.com)。

- **CN Jira** `cnpmp.amway.com.cn/jira` (Data Center 10.3.8)：用 `Authorization: Bearer <cnjira.key>`。账号 cnu07lq3/JIRAUSER14930。
- **Cloud Jira** `amwaycloud.atlassian.net`：cloud.key 是纯 token，需拼 Basic auth = `base64(Jimmy.Xie@Amway.com:<cloud.key>)`（Bearer 会 403）。Cloud 旧 `/search` 已废弃，搜索用 `POST /rest/api/3/search/jql`。

**权限边界（两边都一样）**：我是 BTP 和 TE 的**项目管理员(PROJECT_ADMIN)**，但**非实例管理员**(ADMINISTER=false)。能管项目角色/版本/模块/看板 + 事务全生命周期；**不能**新建或编辑工作流/状态/issue类型/字段/屏幕/scheme——读 `workflow/search`、`workflowscheme/project`、`screens` 均返回 403。要改工作流必须找实例管理员。

完整配置归纳与 BTP 复现建议见 `jira-workflow/TE-Trident-配置归纳与BTP复现参考.md`。相关：[[ebs-jira-review-uses-cloud-te]]。

**team-managed（项目级私有配置）是 Jira Cloud 专属，Data Center 从未支持**（非版本/非开关问题）。CN 是 DC 10.3.8 → 无法做项目私有 template，只能走 company-managed 事实隔离（新字段 context 限 BTP + 独立 BTP_ scheme 集合 + 专属命名）。BTP 最终配置工单见 `jira-workflow/BTP-Jira配置工单.md`。
<!-- created=2026-08-16, last=2026-08-16 -->
