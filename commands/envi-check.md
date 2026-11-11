---
description: 检查 ENVI 环境并列出可用任务
---

先调用 `envi_info` 工具确认 ENVI 安装与任务引擎状态。`envi_info` 返回 `usable: true` 才继续。

如果可用，调用 `envi_tasks` 获取实时任务目录（本机实测 295 个任务、30 个类别），整理成简短报告：

- ENVI 安装路径（`enviHome`）与任务引擎路径（`taskEngine`）
- 引擎是否可用、执行通道（`channel`）
- 任务总数与主要类别

如果 `envi_info` 报不可用，说明 ENVI 安装位置未被自动探测到：提示用户在 profile 的用户补丁层里给 `envi` 条目加 `installDir` / `idlDir` 配置，然后重启。

$ARGUMENTS
