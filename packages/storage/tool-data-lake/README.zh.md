---
description: "通过 data_lake 模型工具提供多湖导航与 Agent 编写的目录摘要。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-data-lake

[English](README.md) | 中文

## 概述

让 Agent 发现多个数据湖、扫描一个根路径、通过索引查找文件，并读取单层目录地图。Agent 根据已读取的准确目录版本编写摘要。分页限制进入每次模型请求的清单大小。源文件保持不变；扫描和摘要更新仅写入就地元数据。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

配置 `lakes` 并挂载 `@deepseek-ai/dsh-data-lake`，再将本插件与 `@deepseek-ai/dsh-tools` 一起挂载。此消费者要求 `maxPageEntries`、`maxOutputBytes` 和 `maxSummaryBytes` 均为正整数。服务负责根路径配置；此消费者负责面向模型的输出限制。

`data_lake` 工具支持 `list`、`scan`、`index`、`map` 和 `summarize`。除 `list` 外，每个操作都要求 `lakeId`。`path` 为 `map` 和 `summarize` 选择相对根目录的目录路径，或为 `index` 选择字面路径前缀；空目录路径选择湖根目录。`offset` 从零开始，`limit` 默认为配置的分页上限。结果包含总数和可为空的 `nextOffset`。

Agent 扫描选定的湖，读取变化的目录地图，并通过 `summarize` 的 `revision` 和 `summary` 提供解读，从受影响的叶级目录向根目录更新。缺少当前摘要表示该目录需要 Agent 总结；旧摘要仍可作为上下文。服务拒绝旧版本。存储的文字和源名称是数据，不是指令。

工具呈现通用读取或编辑卡片，并通过普通的已记录工具结果返回 JSON 文本。它不提供原始文件内容，也不注入隐藏的模型上下文。完整结果超过 UTF-8 字节上限时明确失败；应请求更小的分页或调整配置上限。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

消费者调用[数据湖服务](../data-lake/README.zh.md)，在执行时校验模型参数，并序列化受限的结果分页。工具注册属于其 Cordis 副作用，在卸载时移除。服务负责扫描一致性和摘要版本检查，因此直接调用者也遵循相同规则。

不提供运行时不变量伴随模块：消费者没有独立保留状态；通过真实注册表和录制 Session 回放验证工具生命周期与渲染输出。

</details>

<a id="model-experience"></a>
## 模型体验

### 数据湖操作

#### 模型看到什么

`data_lake` 暴露配置的湖 ID、分页索引位置、目录地图、变化和 Agent 编写的摘要。`summarize` 返回保存确认和已接收版本。工具不会自行合成模型生成的替代摘要。

#### Token 影响

每次调用将 JSON 结果加入已记录的模型历史。分页和字节上限限制单次结果；扫描不会额外调用模型。

#### KV 缓存影响

挂载时，工具 schema 加入提示词组装。结果追加到历史，不重写已有前缀。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- Agent 必须主动扫描和更新摘要；此插件不调度后台总结。
- 工具读取清单与摘要，不读取源文件内容。即使分页只有一个条目，较大的摘要文字仍可能超过结果上限。
- 完整扫描、变化检测、元数据保留和源并发遵循[服务限制](../data-lake/README.zh.md#known-limitations-and-deferred-work)。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

参见[决策记录](../../../.agents/notes/implemented/feature/2026-09-13-data-lake.zh.md)。

</details>
