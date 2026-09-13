---
description: "为多个磁盘目录或 S3 前缀建立索引，每个湖具有唯一根目录索引、目录内地图和 Agent 编写的摘要。"
kind: "package-reference"
---

# @deepseek-ai/dsh-data-lake

[English](README.md) | 中文

## 概述

为多个独立数据湖建立索引，每个湖对应一个磁盘目录或 S3 桶前缀。每个湖具有一个根索引，用于定位文件与目录地图。每个目录保存自己的单层地图和 Agent 编写的摘要。重新扫描会识别清单变化，并使受影响目录及其祖先目录的摘要过期，不会修改源文件。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在 profile 组合中挂载此插件。通过 `lakes` 配置不同的 ID 和根路径；每项必须指定 `id`、`root` 和正整数扫描上限 `maxEntries`。磁盘根路径必须是绝对目录路径。S3 根路径使用 `s3://bucket/prefix/`，并且必须指定 `region`；`endpoint` 和 `forcePathStyle` 可选择兼容 S3 的服务。S3 凭证由 AWS SDK 凭证提供链解析，不保存在索引记录中。

调用 `ctx.dataLake.list()` 枚举数据湖，再调用 `scan(lakeId)` 构建指定湖的索引。`catalog(lakeId)` 读取根索引；`directory(lakeId, path)` 读取一个地图及其摘要。目录路径相对于湖根目录，以 `/` 结尾；空字符串表示根目录。`summarize(lakeId, path, revision, text)` 记录 Agent 编写的摘要；如果指定版本与当前索引不同，则拒绝写入。这些方法支持可选的最后一个取消信号参数。

源根目录必须已存在，并允许写入元数据。每个被索引目录的元数据保存在 `.dsh-data-lake/` 内。只有湖根目录包含 `.dsh-data-lake/index.json`；目录地图与摘要分别保存在该目录元数据文件夹下的 `maps/<revision>.json` 和 `summaries/<revision>.json`。根索引记录这些位置。元数据文件夹不会成为源条目。

地图只包含直接子项，以及自身父级、深度、版本、相对于上次索引地图的变化和最近可用摘要。当前摘要独立保存，在 Agent 写入之前为空。Agent 结合地图、变化、旧摘要和源内容总结受影响目录，从变化的叶级目录逐层向上更新。扫描本身不调用模型，也不生成文字摘要。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

服务为配置的各个湖维护独立操作队列。索引器使用源接口，由磁盘和 S3 提供者分别实现。它收集目录清单，先计算子级版本再计算父级版本，写入地图，最后发布根索引。扫描失败时保留上一次根索引；失败前写入的元数据可能留存。卸载时取消排队及运行中的任务，并等待其结束后释放 S3 客户端。

磁盘清单使用文件大小和修改时间；S3 清单还保留 ETag。符号链接只记录而不遍历。S3 清单读取所有后续分页，并区分名为 `a` 的对象与名为 `a/` 的前缀。面向模型的消费者与此服务分离。

不提供运行时不变量伴随模块：每次操作都会从介质读取索引，并验证引用与版本。不存在可独立修改的进程内投影需要比对；源变化由扫描观察。

</details>

<a id="model-experience"></a>
## 模型体验

### 索引记录

#### 模型看到什么

不会直接看到任何内容。`ctx.dataLake`不提供工具或提示词；消费者选择索引记录，通过自身写入日志的工具结果暴露内容。

#### Token 影响

不直接发起模型请求或消耗请求 token。

#### KV 缓存影响

不直接改变请求前缀。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- 扫描枚举整个湖，并将索引保留在内存中，受每个湖配置的 `maxEntries` 限制。不提供文件监听、S3 通知订阅或自动 Agent 调度器。
- 变化依据源元数据，而非完整内容哈希。磁盘文件在大小和修改时间均不变时被改写，可能无法识别；摘要描述最近索引版本，不代表尚未扫描的源变化。
- 每个根路径由一个活动写入者持有。不协调独立进程或物理路径重叠的湖。扫描期间修改源数据可能产生跨时间点清单或 IO 错误。
- 保留旧地图和摘要文件，尚未实现自动清理。S3 前缀因元数据而留存时，即使源对象已删除，仍可导航到该前缀。
- 拒绝包含点路径段、反斜杠或保留元数据组件的路径。兼容 S3 的行为通过 HTTP 测试夹具验证；实际部署需要自身凭证和验证。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

参见[决策记录](../../../.agents/notes/implemented/feature/2026-09-13-data-lake.zh.md)。

</details>
