---
name: envi
description: Operate ENVI remote-sensing software through its own task engine - discover the live task catalog, inspect parameter contracts, run atmospheric correction, classification, mosaics, reprojection, spectral analysis, ROI work and 290+ other tasks headlessly. Use whenever the user asks for ENVI processing, remote-sensing image analysis, band math, spectral indices, or any ENVI task.
---

# ENVI（遥感处理）

通过 ENVI 自带的任务引擎（`taskengine.exe`）无人值守执行遥感影像处理。**26 个工具，覆盖 295 个 ENVI 任务**。

## 为什么走任务引擎

ENVI 5.6 自带的 IDL 8.8 是运行时虚拟机：`idl.exe -e`、批处理 `.pro`、`idlrt -e` 都**不会执行代码**（实测结论）。唯一能无人值守执行的是 ENVI 自己的任务引擎：

```
taskengine.exe ENVI
stdin  -> {"schema":"envitask","taskName":"...","inputParameters":{...}}
stdout -> {"outputParameters":{...}}
```

它不开窗口、不弹对话框，返回真实处理结果。所有工具底层都走这条通道。

## 先探环境

**任何操作前先调 `envi_info`**：报告 ENVI 安装路径、任务引擎是否可用。若不可用，说明安装位置特殊，需在插件配置里设 `installDir`。

## 工具分组

**能力发现（先查再跑）**
- `envi_tasks` — 实时任务目录（295 个），按类别或名称过滤。**不确定用哪个任务时先查这个**
- `envi_task_info` — 某个任务的完整参数契约
- `envi_task_run` — 用任意参数跑任意任务（通用入口）
- `envi_task_run_async` / `envi_job` / `envi_job_kill` — 长任务的异步作业管理

**影像基本信息与统计**
- `envi_raster_info` — 尺寸、波段数、数据类型、投影、像元大小
- `envi_raster_statistics` — 最小值/最大值/均值/标准差

**常用处理**
- `envi_atmospheric_correction` — 大气校正
- `envi_subset` — 裁剪（按行列范围或地理范围）
- `envi_resample` — 重采样
- `envi_reproject` — 投影转换
- `envi_mosaic` — 镶嵌
- `envi_band_math` — 波段运算
- `envi_spectral_index` — 单指数计算（NDVI、NDWI 等）
- `envi_spectral_indexes` — 可用指数清单
- `envi_spectral_analysis` — 光谱分析

**分类**
- `envi_classify` — 监督/非监督分类
- `envi_classification_cleanup` — 分类后处理（聚类、筛选）
- `envi_classification_to_vector` — 分类结果转矢量

**ROI 与矢量**
- `envi_roi_create` — 从坐标/网格创建 ROI
- `envi_roi_from_threshold` — 按阈值从影像生成 ROI
- `envi_roi_samples` — 从 ROI 提取样本
- `envi_roi_statistics` — ROI 内统计
- `envi_vector_to_roi` — 矢量转 ROI

## 使用要点

1. **先 `envi_info`，再 `envi_tasks` 找任务，然后 `envi_task_info` 看参数，最后 `envi_task_run`**。参数名必须精确匹配契约，猜错会返回 "Task execution failed"。
2. **输出文件不能已存在**——ENVI 拒绝覆盖。需要重跑时显式传 `overwrite: true`，工具会先清理。
3. **输入文件路径要先确认存在**。工具会预检并在缺失时直接报"文件不存在"，不会白等引擎启动（每次约 6 秒）。
4. **长任务用异步**：镶嵌、训练这类可能超过默认 15 分钟的，用 `envi_task_run_async` 拿 job id，再用 `envi_job` 查进度。
5. **一次任务一个进程**：并发调用是安全的，不同输出路径完全并行。
6. 工具返回 `{status, reason}` 结构；`status: "ok"` 才是成功，失败时 `reason` 里是引擎的原始错误。

## 与 ZCode 版的区别

本技能随 DSH 插件 `dsh-envi` 一起下发。ZCode 版的 `shim.mjs`（假 ctx 收集工具）和 `server.mjs`（MCP stdio 服务端）在 DSH 中没有对应物：DSH 本身就是 Cordis 宿主，上游 `upstream/index.js` 的 `apply` 直接挂到真实 `ctx` 上。上游 9 个 lib 模块（task-engine、discovery、jobs、safety、roi、classify、raster-ops、output）原样复用，工具行为与上游完全一致。
