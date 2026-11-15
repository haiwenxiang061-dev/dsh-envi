# dsh-envi

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-0e7490)](https://github.com/topics/dsh-plugin)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4d6bfe)](https://github.com/deepseek-ai/deepseek-harness)

DeepSeek Harness 的 ENVI 遥感处理插件：**26 个工具，覆盖 295 个 ENVI 任务**，全部走 ENVI 自带的任务引擎（`taskengine.exe`），无人值守、不开窗口、不弹对话框。

本仓库是 ZCode 版 `envi-mcp` 0.8.1 的 **DSH 原生形态移植**。两侧共用同一份上游实现（`upstream/`），只换了宿主接入层：

| | ZCode 版 | 本版（DSH bundle） |
|---|---|---|
| 宿主接入 | `shim.mjs` 造一个假 `ctx` 收集工具 | 不需要：DSH 就是 Cordis 宿主 |
| 对模型暴露 | `server.mjs` stdio JSON-RPC（MCP） | `ctx.tools.register` 直连 |
| 技能 | 目录扫描 `skills/envi/SKILL.md` | `ctx.skills.register` + 目录兜底 |
| 斜杠命令 | `commands/envi-check.md` | 同文件 → user-invocable skill |
| 系统提示 | 无 | `systemPrompt.section`（上游自带） |
| 环境变量 | 无 | `shellEnv.register`（上游自带） |

`shim.mjs` 和 `server.mjs` 在移植中删除：它们存在的唯一理由是把 Cordis 插件伪装成 MCP 服务端。

## 目录结构

```
dsh-envi/
├── index.js              # 入口：转发 lib/index.js 的命名空间（含 default）
├── package.json          # main + exports + dsh.bundle.patch
├── cordis.patch.yml      # bundle 补丁：insert envi 条目
├── lib/index.js          # DSH 侧 apply：工具 + 技能 + 命令
├── upstream/             # 上游实现，原样复用（9 个 lib 模块 + index.js）
├── skills/envi/SKILL.md  # envi 技能正文
├── commands/envi-check.md# /envi-check 命令正文
└── test/                 # 真 Cordis 挂载测试 + 真 ENVI 端到端测试
```

## 安装

### 方式一：从 npm 安装

```bash
dsh plugin --profile web add dsh-envi
dsh plugin --profile desktop add dsh-envi
```

`desktop` 是带窗口的桌面 profile，`web` 是浏览器 profile；把 profile 名换成你实际要装的那个。
装完刷新页面即生效，插件出现在「设置 → 插件」里，行内标注 **ENVI 遥感处理**。

> 该包当前**尚未发布到 npm**，上面的命令会解析失败。现在要装请用方式二。

### 方式二：从 GitHub 安装（现在可用）

钉住 tag 的 tarball 地址，下载后直接解包安装，不需要 git 传输：

```bash
dsh plugin --profile web add https://codeload.github.com/haiwenxiang061-dev/dsh-envi/tar.gz/refs/tags/v0.8.1
dsh plugin --profile desktop add https://codeload.github.com/haiwenxiang061-dev/dsh-envi/tar.gz/refs/tags/v0.8.1
```

Release 里也挂了同一份 `.tgz` 附件，想用 GitHub 的下载页可以换成：

```bash
dsh plugin --profile desktop add https://github.com/haiwenxiang061-dev/dsh-envi/releases/download/v0.8.1/dsh-envi-0.8.1.tgz
```

两点实测注意：
- `dsh plugin` 会把参数转发给 profile 目录里的 pnpm，所以本机需要能调到 `pnpm`（`npm i -g pnpm` 即可）。
- 不建议用 `github:haiwenxiang061-dev/dsh-envi` 这种简写：它走 git 传输协议，在国内网络下经常被 reset；上面的 codeload 地址走 HTTPS 下载，稳定得多。

### 方式三：加进 profile 的 bundle 栈

在 `$DSH_HOME/profiles/<profile>/package.json` 里加依赖和 bundle 条目：

```json
{
  "dependencies": {
    "dsh-envi": "file:../../../workplace/dsh-envi"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-envi"]
    }
  }
}
```

然后把包链接进 profile 的 `node_modules`（或在 profile 目录跑 `pnpm install`），重启 Harness。
`bundles` 数组末尾的条目最后加载，`envi` 条目由 `cordis.patch.yml` 自动插入。

### 方式四：patch overlay

不改 profile 的 bundle 栈，直接插一条：

```yaml
# envi.yml
- insert:
    - id: envi
      name: 'file:///D:/workplace/dsh-envi/index.js'
```

```bash
dsh <profile> --patch ./envi.yml
```

> **入口必须写成 `…/dsh-envi/index.js`，不能只写目录。** Cordis 用 `import()` 加载条目，
> Node ESM 不支持目录导入，会报 `ERR_UNSUPPORTED_DIR_IMPORT`。

## 配置

```yaml
- id: envi
  name: dsh-envi
  config:
    installDir: 'C:\Program Files\Harris\ENVI56'   # 自动探测失败时才需要
    idlDir: ''                                      # 默认 <installDir>\IDL88
    taskTimeoutMs: 900000                           # 单任务超时，默认 15 分钟
    catalogCacheMs: 60000                           # 任务目录缓存
    scratchDir: ''                                  # 引擎日志目录，Win 默认 F:\workspace
    modelInvocableCommand: false                    # envi-check 是否也进模型目录
    filesystemFallback: true                        # 同时从磁盘发现 skills/ 与 commands/
```

## 实测状态

本机（ENVI 5.6 / IDL 8.8）验证结果：

- `envi_info` → `usable: true`，通道 `taskengine.exe ENVI`，引擎 `C:\Program Files\Harris\ENVI56\IDL88\bin\bin.x86_64\taskengine.exe`
- `envi_tasks` → **295 个任务 / 30 个类别**（经真实 taskengine 拉取，非硬编码）
- Cordis 真实组合挂载：26 个工具 + 2 个技能全部注册，`ctx.dispose()` 干净卸载
- **26 个工具逐个真调 ENVI 验证通过**（`test/coverage.mjs`，30 项断言 / 27 次调用全 PASS）

### 实测发现的 ENVI 硬性限制

这轮全覆盖跑出两条不是本插件能修、但必须提前说清的限制，工具已在调用前拦截并给出可执行的替代做法：

| 场景 | ENVI 行为 | 插件处理 |
| --- | --- | --- |
| `ExtractExamplesFromRaster` 跑在单波段影像上（如 `bhdemsub.img`） | 报 `Mismatched dimensions between class values and examples`；同一套 ROI 放到 6 波段 `bhtmref.img` 上正常 | `envi_roi_samples` 先查 `NBANDS`，单波段直接 `refused` 并提示改用 `envi_roi_statistics` 或先 `envi_mosaic mode=stack` |
| 阈值型 ROI（`<ThresholdDef>`）提取样本 | 报 `The ROIs do not intersect the raster`，因为 ENVI 按 `<Source>` 惰性求值，区域不会落成像素 | 识别 `<ThresholdDef>` 后换成中文说明，提示用 `envi_roi_create` 列出采样点 |
| 单波段影像算协方差 | 报 `Input raster should have at least two bands to compute covariance` | 原样透出英文原因（属于输入不合规，不是缺陷） |

另外修掉一个移植遗留缺陷：ENVI 头文件 UTM 的 `map info` 末尾常是 `units=Meters` 而非 datum，旧代码把它当 datum 查椭球表失败，导致**普通 UTM 影像也无法建 ROI**；现改为认不出的第 10 项回退 WGS-84。

## 兼容与权限

| 项 | 值 |
| --- | --- |
| DSH 版本 | 0.2.x，`dsh.bundle.patch` + 导出 `apply(ctx)` |
| 平台 | Windows（ENVI 的任务引擎 `taskengine.exe` 仅 Windows 版） |
| 外部依赖 | 本机已安装 ENVI（自带 IDL 运行时）；解释器路径由 `installDir` / `idlDir` 配置或自动探测 |
| 权限 | 以子进程调用 `taskengine.exe` 执行任务；写影像的工具（`envi_subset`、`envi_resample`、`envi_mosaic`、`envi_band_math`、`envi_classify` 等）要求 `writeAllowed: true` |
| 网络 | 不联网 |
| 许可证 | MIT |

## 测试

测试必须用 Harness 自带的 Electron 作为 Node 运行（`@deepseek-ai/*` 位于 `app.asar` 内）：

```bash
cd dsh-envi
ELECTRON_RUN_AS_NODE=1 "D:/1/DeepSeek Harness.exe" --expose-internals \
  --import ./test/hooks.mjs test/activate.mjs     # 26 工具 + 2 技能
ELECTRON_RUN_AS_NODE=1 "D:/1/DeepSeek Harness.exe" --expose-internals \
  --import ./test/hooks.mjs test/envi-live.mjs    # 真调 ENVI
ELECTRON_RUN_AS_NODE=1 "D:/1/DeepSeek Harness.exe" --expose-internals \
  --import ./test/hooks.mjs test/envi-tasks.mjs   # 真拉 295 任务
ELECTRON_RUN_AS_NODE=1 "D:/1/DeepSeek Harness.exe" --expose-internals \
  --import ./test/hooks.mjs test/coverage.mjs     # 26 个工具逐个真调，全绿才算可用
```

## 工具清单（26）

**能力发现** `envi_info` `envi_tasks` `envi_task_info` `envi_task_run` `envi_task_run_async` `envi_job` `envi_job_kill`

**影像信息** `envi_raster_info` `envi_raster_statistics`

**常用处理** `envi_atmospheric_correction` `envi_subset` `envi_resample` `envi_reproject` `envi_mosaic` `envi_band_math` `envi_spectral_index` `envi_spectral_indexes` `envi_spectral_analysis`

**分类** `envi_classify` `envi_classification_cleanup` `envi_classification_to_vector`

**ROI / 矢量** `envi_roi_create` `envi_roi_from_threshold` `envi_roi_samples` `envi_roi_statistics` `envi_vector_to_roi`

## 许可

MIT。上游实现源自 ZCode `envi-mcp` 0.8.1。
