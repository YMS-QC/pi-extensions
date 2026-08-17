**feedback_xlsx_nodejs_only** — PA-flow 项目里 **所有 xlsx 操作（读 + 写）都用 Node.js + ExcelJS**，不要回到 Python。

**Why:** 上一轮 Python openpyxl 生成的 xlsx 触发 Excel "文件有问题，是否尽量恢复" 警告；切到 ExcelJS 后修复。用户随后明确："maybe nodejs did better than python in xlsx" + 在本轮再次纠正"我让你用 nodejs 做 xlsx，不是 python"。即便只是临时读 xlsx 也不要切回 Python——一致用 ExcelJS 才不会让用户觉得反复。

**How to apply:** 项目目录 `/mnt/c/amway_repo/pa-flow/` 下涉及 xlsx 的任何脚本（含临时读取脚本）都写在 `/tmp/xlsx_node/` 用 ExcelJS。读 xlsx 用 `new ExcelJS.Workbook().xlsx.readFile(path)`，写 xlsx 用同对象 `.xlsx.writeFile(path)`。**不要** `python3 -c "import openpyxl..."` 即使只是为了 dump 内容。
<!-- created=2026-08-16, last=2026-08-16 -->
