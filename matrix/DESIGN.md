# Matrix 代办系统设计文档
1. 项目目标
构建一个极简、高效、可离线、支持 Markdown 的个人代办系统，核心原则：零配置、即时可用、纯本地文件存储。
2. 目录结构



text

matrix/
├── todos.json          # 主数据文件（JSON Lines 格式）
├── archive.json        # 已完成/归档任务
├── tags/               # 标签索引（可选，未来）
├── views/              # 预置视图（如 today.md、week.md）
└── templates/          # 任务模板
3. 数据格式（todos.json）
每行一个任务（JSON Lines）：



JSON

{"id":"m20260405-001","content":"完成 Matrix 设计文档","status":"pending","priority":"high","created":"2026-04-05T11:35:00+08:00","tags":["design","core"],"due":null}
4. 核心特性（V1）

 创建/完成/删除任务

 Priority（high/medium/low）

 Tags 多标签

 Due date（可选）

 纯本地，无后端

 CLI + TUI 双模式

 视图：Inbox / Today / Next7 / Someday

5. 技术栈

语言：Rust（主）+ TypeScript（可选 Web UI）

CLI 框架：clap + ratatui

数据：JSON Lines（便于 git 追踪）

存储：单文件 todos.json + archive.json

6. 后续规划

V2：加密存储（age）

V3：同步（syncthing/git）

V4：插件系统（过滤器、自动化）

状态：设计完成，准备进入开发。

