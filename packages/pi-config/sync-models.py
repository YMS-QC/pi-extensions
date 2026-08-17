#!/usr/bin/env python3
"""
sync-models.py — 从 ~/.pi/agent/my-models.json 渲染模型配置到各目标文件。

源格式:
  { "main": {"provider": "zai", "model": "glm-5.3"},
    "aux":  "zai/glm-4.7" }

目标(幂等, 只动模型字段, 其余键保留):
  1. ~/.pi/agent/settings.json            → defaultProvider + defaultModel
  2. ~/.pi/agent/automode.json            → autoMode.classifierModel
  3. ~/.pi/agent/hermes-memory-config.json→ llmModelOverride (+llmThinkingOverride 保持不动)
"""
import json, sys, os
from pathlib import Path

AGENT = Path.home() / ".pi/agent"
SRC = AGENT / "my-models.json"

def load(p): return json.loads(Path(p).read_text(encoding="utf-8"))
def save(p, obj):
    Path(p).write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

def main():
    src = load(SRC)
    main_cfg, aux = src["main"], src["aux"]
    changed = []

    # 1. settings.json
    p = AGENT / "settings.json"
    s = load(p)
    if s.get("defaultProvider") != main_cfg["provider"] or s.get("defaultModel") != main_cfg["model"]:
        s["defaultProvider"], s["defaultModel"] = main_cfg["provider"], main_cfg["model"]
        save(p, s); changed.append(f"settings.json → {main_cfg['provider']}/{main_cfg['model']}")

    # 2. automode.json
    p = AGENT / "automode.json"
    if p.exists():
        a = load(p)
        am = a.get("autoMode", {})
        if am.get("classifierModel") != aux:
            a.setdefault("autoMode", {})["classifierModel"] = aux
            save(p, a); changed.append(f"automode.json → classifier {aux}")

    # 3. hermes-memory-config.json
    p = AGENT / "hermes-memory-config.json"
    if p.exists():
        h = load(p)
        if h.get("llmModelOverride") != aux:
            h["llmModelOverride"] = aux
            save(p, h); changed.append(f"hermes-memory-config.json → override {aux}")

    if changed:
        print("\n".join("✓ " + c for c in changed))
    else:
        print("已是最新, 无变更")

if __name__ == "__main__":
    main()
