# pi-extensions（YMS-QC 私有）

单一 monorepo 统管 pi 扩展装载与资产。源码来源见 [SOURCES.md](./SOURCES.md)。

## 结构

```
packages/stack/     收纳的第三方扩展（已打补丁，pi 直接装载本区）
  pi-telegram/ pi-automode/ pi-hermes-memory/
packages/           自有资产（agents / config / model-config）
```

settings.json 唯一 git pin：`git:github.com/YMS-QC/pi-extensions@main`（root package.json
的 pi manifest 只列 stack 区入口，源码直载零构建）。

## 日常操作

| 操作 | 命令 |
|---|---|
| 同步上游（subtree pull，无需 fork 仓） | `./update-vendors.sh` → `pi update --extensions` |
| 给收纳包打补丁 | 直接改 `packages/stack/<pkg>/`，提交推送，`pi update --extensions` |
| 部署自有资产 | `./deploy.sh` |
| 新收纳一个第三方包 | `git subtree add --prefix=packages/stack/<pkg> <上游URL> <分支>`，并在 SOURCES.md 登记 |
