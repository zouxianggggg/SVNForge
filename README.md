# SVNLens

SVNLens 是一个面向 Visual Studio Code 的 Apache Subversion 扩展，目标是提供接近 Git 原生体验的 SVN 工作流，并补齐日志、分支、远程浏览、冲突处理和逐行追踪等高级能力。

当前版本已经实现以下能力：

- 基于 `svn` CLI 的 checkout、import、update、commit、switch、merge、patch、ignore、resolve 等命令封装
- Source Control 面板集成，展示 modified、added、deleted、conflicted、unversioned 状态
- 状态栏显示当前 SVN 路径和 revision
- Quick Diff 与工作副本/指定 revision 对比
- SQLite 本地日志缓存（基于 `sql.js`）和分页日志 / 文件历史面板
- 逐行 blame 装饰与 hover 提示
- 仓库浏览、branches/tags 树形浏览与创建分支/标签命令
- 冲突高亮、一键 accept mine / accept theirs / mark resolved
- 多工作区根目录下的独立仓库管理
- Jenkins 状态扩展点
- Repository Browser 支持仓库根、当前分支、trunk/branches/tags 书签和自定义远程 URL 固定入口
- svn:ignore 图形化管理支持建议条目、批量删除和批量替换
- 提供本地 SVN 烟测脚本、VS Code 调试配置和 VSIX 打包脚本
- 提供扩展宿主集成测试，覆盖仓库发现、日志/图谱/文件历史面板以及冲突解决命令
- 提供 Repository Dashboard Webview，将远程仓库浏览与提交图谱放在同一个工作台中

## 开发

1. 运行 `npm install`
2. 运行 `npm run compile`
3. 在 VS Code 中按 `F5` 启动扩展开发宿主

### 调试

- `Run SVNLens`：先编译，再启动扩展开发宿主
- `Run SVNLens Watch`：启动 `tsc -watch` 后运行扩展宿主
- `npm run smoke:svn`：创建临时本地仓库，执行 checkout、commit、branch、switch、merge、ignore、patch 等真实 SVN 命令烟测
- `npm test`：启动 VS Code 扩展宿主并执行自动化集成测试

### 打包

- `npm run package:vsix`：编译并生成 VSIX 包
- `npm run publish:dry-run`：执行打包前检查并生成发布包，适合作为发布前自检

### CI

- GitHub Actions 工作流位于 `.github/workflows/ci.yml`
- 在 Linux 环境中安装 Subversion 后执行 compile、extension host tests、smoke tests 和 VSIX 打包
- `.github/workflows/publish.yml` 支持 tag 发布和手动触发发布
- 发布到 VS Code Marketplace 需要配置仓库 secret：`VSCE_PAT`

## 架构

- UI 层：SCM 资源组、树视图、状态栏、Webview 面板、blame/冲突装饰
- Service 层：仓库管理、日志缓存、CI 状态、命令协调
- SVN Adapter 层：`child_process` + `svn` CLI 调用与 XML 解析