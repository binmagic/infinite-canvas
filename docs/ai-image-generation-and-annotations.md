核心机制和文档描述的一致：**视觉栅格化 + 提示词引导，没有任何结构化语义解析**。但实现层面几乎完全不同——infinite-canvas 不用 tldraw、不用 Agent 工具链，是自己手写 Canvas 2D 画箭头。

## 对比表

| 维度 | Cowart（文档） | infinite-canvas（实际代码） |
| --- | --- | --- |
| 画布底座 | tldraw shapes + store + IndexedDB | 自研节点模型（`CanvasNodeData`）+ React state |
| 标注入口 | 主画布上的工具状态机 `CowartAnnotationPointing` | 独立弹窗 `canvas-node-annotation-edit-dialog.tsx`（943 行） |
| 箭头存储 | 真实 tldraw arrow shape，`meta.cowartAnnotationArrow = true`，持久化 | 纯 JS 对象 `ArrowAnnotation`，存在 React state + 模块级 `annotationDraftStore` Map（按 nodeId 缓存草稿） |
| 箭头渲染 | `editor.toImageDataUrl()`，tldraw 原生渲染 | 手写 Canvas 2D：`drawArrowShaft`（arc 用 `quadraticCurveTo`，elbow 用两段 `lineTo`）+ `drawArrowheadShape`（8 种箭头头）+ 手动 dash 图案 |
| 注释文字 | 箭头的 `props.richText`，**被 tldraw 一起烤进参考图** | 每条箭头独立 `description`，用 HTML `<div>` 覆盖层显示，**不进图片**，只进提示词 |
| 驱动方式 | Agent `streamText` + 4 个 tool 循环 | 无 Agent、无工具调用，弹窗确认 → 直接 HTTP |
| 结果落地 | `insert_image` tool → holder 填充或 anchor 布局 → `store.put` | 直接建子节点（`x + width + 96`）+ 连线，`requestEdit()` |
| Provider 层 | `imageAdapters.js` 4 个硬编码适配器 | `services/api/image.ts` 按 `apiFormat` 分支 + 用户自定义渠道 + `runModelPlugin` 脚本逃生口 |

## 几个关键差异

**1. 手工复刻了 tldraw 的观感。** 代码里有明确注释（`canvas-node-annotation-edit-dialog.tsx:53`）：12 色调色板是"tldraw 5.1.1 default palette，replicated so the arrow style controls match Cowart's default style panel exactly"。连 `dash: "draw"` 手绘感也是靠**描两遍**模拟的——第二遍偏移 1px、透明度 0.45（`:775`）。这是刻意对齐 Cowart 的视觉，但走的是完全不同的实现路径。

**2. 留白画布，箭头可以从图外指进来。** `PADDING_RATIO = 0.4`（`:71`），画布是图片四周各加 40% 留白。合成时（`buildAnnotatedImage:922`）先填**白底**，再把原图画在偏移位置，再叠箭头层。Cowart 是 tldraw 的 `padding: 'auto'` + `background: true`。

**3. 提示词分两层拼。** 弹窗里 `buildCombinedPrompt`（`:936`）把每条箭头的描述编号成 `1. xxx\n2. yyy`；然后 `project.tsx:1861` 套上 i18n 模板 `annotatePrompt`。最终形态和 Cowart 的 `buildEditPrompt` 三段式一模一样：应用编辑 + 保持原图 + 去除标注痕迹。

## 两个值得注意的实现问题

**编号和图片对不上。** 提示词里写着"不要保留……箭头末端的编号或文字标签"，但整个文件里没有一处 `fillText`——`measureLabelTextWidth`（`:704`）只做宽度测量。也就是说导出的 PNG 里**只有箭头线条和箭头头，没有任何文字或编号**。可是提示词给的是编号指令（`1. 头发改为黄色`），模型没有任何依据把"1."映射到某一条箭头。单条箭头时没问题，多条箭头时对应关系就丢了。Cowart 反而没这个问题——它的标签文字是真的被烤进参考图的。

**选中圈会被烤进导出图。** `buildAnnotatedImage` 直接复制的是**预览 canvas**（`:488`），而预览渲染时传了 `selectedArrowId`，`drawSelectionRing`（`:883`）会画蓝色虚线圈。所以提交那一刻如果有箭头处于选中态，这个圈就进了发给模型的图片——这也解释了为什么中文提示词里要专门写一句"蓝色虚线选中圈"。目前是靠提示词兜底，更干净的做法是提交前用不带 `selectedArrowId` 的参数重画一次。

## 结论

文档第四节的三条核心结论对 infinite-canvas 同样成立：纯视觉合成、无图关系推理、效果取决于模型的多模态理解力。但 infinite-canvas 不是"按这份文档实现的"——它是在一个完全不同的技术栈上，**独立重建了同一套思路**，并刻意对齐了 Cowart 的 UI 观感（调色板注释是直接证据）。差异主要在：单节点弹窗 vs 画布多选、手写渲染 vs 原生栅格化、直连 API vs Agent 工具链、以及注释文字走提示词 vs 走图像。