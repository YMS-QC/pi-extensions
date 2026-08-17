TE-1631 评审澄清：XXAMW.MTL_MATERIAL_TRANSACTIONS_N1 索引在 PRD 确定存在，hint 静默失效风险解除（原 H-01 降级为 L-03）。该索引为环境现状（非本 ticket 引入），开发策略为避免动索引，使用 hint 复用现有对象（M-01 转为 WONTFIX 移交 DBA）。 <!-- created=2026-08-17, last=2026-08-17 -->
§
TE-1631 系统设置.docx（快码 XX_CST_WAREHOUSE_GROUPING 变更）确认为本 ticket 部署依赖，但 Migration 清单未列入（M-03 问题）。包内 6 处引用该快码，docx 为 8-17 补传（比代码晚 12 天）。 <!-- created=2026-08-17, last=2026-08-17 -->