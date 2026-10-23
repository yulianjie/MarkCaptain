# M0 基线与可复现夹具

记录日期：2026-10-22

应用版本：0.8.4，基线提交 `a5be6a1`

平台：Windows 11 专业版 x64，OS build 26200

## 夹具

`test/fixtures/m0-representative.md` 是小型、可审阅的固定输入，覆盖 YAML frontmatter、中文/英文/Emoji/非 BMP 字符、标题、普通链接和双链、相对 SVG、表格、任务列表、引用块、TS/Rust 代码围栏、公式、Mermaid、脚注和引用式链接。资源位于同目录下的 `m0-assets/diagram.svg`。

大样例由 `scripts/m0-generate-fixtures.mjs` 确定性生成到 `output/m0-fixtures/`（该目录已在 `.gitignore` 中排除），不会把大文件加入源码。20 万字符用 Unicode code point 计数，Emoji 也计为一个 code point；1 MiB 指 UTF-8 文件精确为 1,048,576 字节。项目夹具按 `--files` 生成 1 至 10,000 个 Markdown 文件，最多每 100 篇分组。

```powershell
node scripts/m0-generate-fixtures.mjs --workload all --files 1200 --out output/m0-fixtures/run-1200
node scripts/m0-generate-fixtures.mjs --workload project --files 10000 --out output/m0-fixtures/run-10000
node scripts/m0-filesystem-benchmark.mjs output/m0-fixtures/run-1200/project --runs 3
node scripts/m0-filesystem-benchmark.mjs output/m0-fixtures/run-10000/project --runs 3
```

`--out` 必须指向一个新目录。脚本只创建文件，不清理已有内容。`scripts/m0-filesystem-benchmark.mjs` 顺序递归枚举 Markdown、顺序读取，并对相对路径与文件字节计算 SHA-256，以验证每轮读取同一输入。它测量的是 Node 文件枚举、读取和哈希耗时，不会调用 MarkCaptain 的索引器、Markdown 渲染或编辑器。

新增单测 `test/unit/m0-fixtures.spec.ts` 检查样例覆盖、相对资源存在、长文字符数、1 MiB 字节数，以及小规模项目文件生成。测试的临时数据写入系统临时目录并在结束时清除。

## 运行环境

| 项目 | 记录 |
| --- | --- |
| OS | Windows 11 专业版，10.0.26200，64 位 |
| CPU | Intel Core Ultra 9 185H，22 逻辑处理器 |
| 内存 | 31.4 GiB 已安装；Node `os.totalmem()` 记录为 33,751,834,624 字节 |
| Node / npm | Node v24.14.1，npm 11.14.0，V8 13.6.233.17-node.44 |
| 锁文件 | package-lock v3；本次使用已有 `node_modules`，没有重装依赖 |
| 实际测试包 | Vite 6.4.2，Vitest 2.1.9，Playwright 1.60.0 |
| 浏览器测试模式 | `npm run test:e2e` 启动 Vite `http://localhost:1420`；是 renderer 浏览器测试，不是 Tauri/WebView2 原生测试 |

## 自动化基线

初始检查时 HEAD 为 `a5be6a1`，工作区没有已修改的跟踪文件；当时仅有本实施方案文档为未跟踪文件。

| 命令 | 结果 |
| --- | --- |
| `npm run test:unit` | Vitest 2.1.9：63 个测试文件、411 项通过；Vitest 报告总时长 7.36 秒。运行开始时工作区状态仍显示没有跟踪文件改动。 |
| `npm exec vitest run test/unit/m0-fixtures.spec.ts` | 新增 M0 夹具测试：1 个文件、4 项通过，1.07 秒。 |
| `node --check scripts/m0-generate-fixtures.mjs` | 通过。 |
| `node --check scripts/m0-filesystem-benchmark.mjs` | 通过。 |

### 浏览器 E2E 捕获的限制

本轮执行 `npm run test:e2e` 后，其他 agent 开始在同一工作区修改 M1 源码。Playwright 启动时共发现 90 项；前 66 项通过，随后在 SideBar 替换期间出现一次 Vite 错误：无法加载 `/src/components/sideBar/SideBar.vue`。失败集中在 notebook 面板场景：#67 与 #69–75 共 8 项失败（7 项等待 `.notebook-panel` 可见失败，1 项超时）；#68 和 #76–80 通过。按主 agent 要求，此轮在 #80 后中断，剩余 10 项未运行。

这是一轮正在热替换源码时的共享工作区运行记录，不能据此把 notebook 失败定性为产品回归，也不是完整通过的 E2E 验收。失败页面截图和 Playwright trace 留在被忽略的 `test-results/` 中供本机诊断。后续源码集成后的完整 Playwright 复验有 102 项通过，见 [M0/M1 验收记录](M1_VALIDATION.md)；本段只保留首轮中断及其并行修改背景。

## 生成与文件读取数据

本次生成数据写入被忽略的 `output/m0-fixtures/`。机器与 Node 运行时如上。下表中的生成时间是文件生成/写入耗时。目录读取基准由三轮连续的递归枚举、顺序 `readFile` 和 SHA-256 组成；当时 Playwright E2E 仍在运行，OS 文件缓存没有控制，因此这些值是共享机器上的参考样本，不作为应用性能指标或回归门槛。

| 负载 | 生成结果 | 生成耗时 |
| --- | --- | ---: |
| 代表性 Markdown | 1 篇及相对 SVG | 5 ms |
| 20 万字符长文 | 200,000 Unicode code point，368,564 UTF-8 字节 | 6 ms |
| 1 MiB Markdown | 1 篇，1,048,576 UTF-8 字节 | 8 ms |
| 项目 1,200 篇 | 330,528 UTF-8 字节 | 420 ms |
| 项目 10,000 篇 | 2,786,876 UTF-8 字节 | 4,381 ms |

| 项目 | 枚举时间（三轮） | 顺序读取与哈希（三轮） | 总时间（三轮） |
| --- | --- | --- | --- |
| 1,200 篇 / 330,528 字节 | 9.614 / 7.779 / 5.637 ms | 219.922 / 233.227 / 206.940 ms | 229.537 / 241.006 / 212.576 ms |
| 10,000 篇 / 2,786,876 字节 | 54.874 / 46.710 / 46.033 ms | 1,951.289 / 2,255.908 / 2,414.577 ms | 2,006.164 / 2,302.618 / 2,460.610 ms |

三轮 SHA-256 在各自负载中保持相同，证明每轮读到了同一组路径和内容。文件系统基准特意不等同于应用索引耗时；M0 尚未建立 Muya 大文档输入、应用索引/取消、导出渲染或用户可感知延迟的基准。本记录不据此承诺性能目标。源码冻结后，可将这些相同夹具交给原生 WebView2 流程重新测量。

## 本轮 Windows 原生补充测量

M1 集成后，使用独立标识 io.github.yulianjie.markcaptain.m1-validation 的真实 WebView2 与 Rust 后端补充采样。可复用脚本为 scripts/m1-native-performance.mjs；产物位于 output/m1-native/performance.json。

| 样例 | 观测值 | 解释 |
| --- | --- | --- |
| 20 万 Unicode 字符可视化 | 打开到双帧就绪约 4.30 秒；12 次 CDP 输入/模型提交采样 P50 约 1139 ms、P95 约 2721 ms | 显示超长可视化文档存在明显编辑成本，不能宣称 50 ms 目标已经达成 |
| 1 MiB 源码 | 打开到双帧就绪约 1.82 秒；12 次 CDP 输入/模型提交 P50 约 38.5 ms、P95 约 200.7 ms | 仅为当前调试构建、当前桌面状态的诊断样本 |
| 1200 文件项目 | 项目枚举、正文读取和别名处理发布到笔记集合约 2.78 秒 | 不等同于所有关系 worker 已完成 |
| 10000 文件项目 | 同一读取流程约 12.34 秒 | 后台解析/关系完成应另行测量 |

这些样本来自未优化 Rust 调试构建、开发前端资源，且同机存在其他验证负载；CDP 往返及页面事件循环包含在输入计时内，不是硬件输入到像素的时延。样本量为 12，不适合作为正式性能保证或与其他编辑器的排名。

基准运行分为文档操作采样和项目读取采样，JSON 为前者保留 fromRun 指针。源文件字节在输入及强制关闭后核对保持不变。编辑器对 Markdown 的尾部换行规范化会使 20 万字符输入的缓冲区统计多一个换行。

该基线的结论是：M0 现已具备可重复的输入与真实桌面诊断数据，但性能目标尚未达标。后续应单独 profile Muya 长文解析、Markdown 序列化、共享历史和索引更新，不能用文件读取速度代替编辑器性能。


## Windows 原生复用入口与后续实测

现有验证脚本可在不 mock Rust IPC 的情况下连到本地开发版 WebView2。先由主 agent 用独立 target 构建并启动带调试端口的 MarkCaptain，参数为 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9335`；脚本连接 `http://127.0.0.1:9335`，临时工作目录位于 `output/notebook-native/`。`scripts/notebook-native-smoke.mjs` 覆盖真实文件扫描、中文路径、别名与同名文件、文件 watcher、保存、引用重命名、分屏共享撤销、外部修改冲突；`scripts/notebook-native-scale.mjs` 当前硬编码 1,200 篇，覆盖真实应用的索引重建、取消、事件让步及搜索结果上限。Agent 原生流程用本地 HTTP 模型 fixture，但 Rust/IPC 保持真实；重启与每窗选区恢复另有对应脚本。

本文件前文的 M0 测试基线与首轮 Playwright 记录是在 M1 实现期间采集的；当时没有启动或操控 Tauri UI。随后 M1 Windows 原生开发版流程已由主 agent 执行，13 项流程全部通过且无页面异常。该轮生产 custom-protocol 复验最初发现 KaTeX 字体外部路径问题；产品修复后，最终生产资源压力复验 10 项通过，真实生成 HTML、DOCX、ODT、EPUB、PDF 并检查源文件字节未变；PDF 已逐页渲染检查。具体构建类型、receipt、打印记录和未完成项见 [M0/M1 验收记录](M1_VALIDATION.md)。开发版 IPC 结果不等同于优化 release 或安装包验收。
