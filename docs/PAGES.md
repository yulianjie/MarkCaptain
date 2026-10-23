# GitHub Pages 维护

站点地址：[yulianjie.github.io/MarkCaptain](https://yulianjie.github.io/MarkCaptain/)。Pages 使用 master 分支根目录的 Jekyll 构建，配置位于仓库根目录的 `_config.yml`。

## 发布范围

首页由 `jekyll-readme-index` 从现有 README 生成。中文 README、docs 文档与 img 图片也参与站点发布，Markdown 内部链接由 `jekyll-relative-links` 转换。

`docs/releases/README.md` 为版本说明目录生成索引，让 README 中的目录链接在站点和 GitHub 上都可访问。新增版本说明时同步更新这个索引。

根目录的 `index.html` 属于 Tauri/Vite 开发入口，引用尚未构建的 TypeScript，不作为静态站点首页。配置仅在 Pages 构建时排除它，桌面开发与打包继续使用原文件。

应用源码、内置技能、测试夹具、脚本、依赖和构建目录不属于站点内容。尤其不能把 src-tauri 下的技能参考资料送入 Jekyll：其中的维基模板示例包含双花括号及竖线，会被 Liquid 当成变量和过滤器执行。修复放在发布范围配置中，内置技能原文保持完整。

## 字面量示例

用户文档中的笔记模板变量需要作为文字显示。NOTEBOOK 文档使用 HTML code 元素和花括号实体，因此 GitHub Markdown 与 Pages 都能显示原来的模板变量，Liquid 不会提前展开它们。

当前 legacy Pages 日志使用 Jekyll 3.10；它的 Liquid 判断没有读取 `render_with_liquid: false`，不能依赖 Jekyll 4 的这一选项。新增含模板语法的文档时，应使用字面量实体或受支持的转义方式，并检查最终页面中的示例是否完整。

## 验证

1. 推送 master 后等待 `pages build and deployment` 的 build、report-build-status 和 deploy 全部成功，并核对运行对应的提交。
2. 检查站点首页为 HTTP 200，显示 README 内容，而不是空的桌面应用容器。
3. 检查主题样式、截图和关键文档链接可访问；检查 NOTEBOOK 页面四个模板变量完整显示。
4. 检查开发源码及技能路径没有出现在 Pages 构建产物中。桌面应用 CI 与 Release 结果独立记录。

本次部署日志和线上检查回执保存在本地 `output/pages-fix`，该目录不提交，也不进入 Pages。

参考：[Jekyll 排除配置](https://jekyllrb.com/docs/configuration/options/)、[README 首页插件](https://github.com/benbalter/jekyll-readme-index)、[Jekyll 3.10 的 Liquid 判断](https://github.com/jekyll/jekyll/blob/v3.10.0/lib/jekyll/convertible.rb#L153-L155)。
