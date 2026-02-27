# OpenLink

> ⚠️ **学习研究项目，非生产用途**
>
> 本项目是作者为**研究底层 Agent 工作原理**而创建的个人学习项目，代码结构和实现均以探索为目的，**不适合用于生产环境**。
>
> **目前实测效果并不理想**：网页版 AI 对工具调用的支持参差不齐，稳定性和准确性均有较大局限，距离实用仍有差距。
>
> OpenLink 通过浏览器扩展模拟用户操作来驱动网页 AI，**并不是一个 API 接口**，不适合作为日常 API 调用使用。请合理使用，勿滥用。

让网页版 AI（Gemini、AI Studio）直接访问你的本地文件系统和执行命令。

## 工作原理

```
AI 网页 → 输出 <tool> 指令 → Chrome 扩展拦截 → 本地 Go 服务执行 → 结果返回 AI
```

## 快速安装

### 第一步：安装本地服务

**macOS / Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/afumu/openlink/main/install.sh | sh
```

**Windows（PowerShell）**

```powershell
irm https://raw.githubusercontent.com/afumu/openlink/main/install.ps1 | iex
```

安装完成后运行：

```bash
openlink
```

服务默认监听 `http://127.0.0.1:39527`，启动后会输出认证 URL。

### 第二步：安装 Chrome 扩展

> Chrome Web Store 版本即将上线，目前请手动安装。

1. 下载最新 [Release](https://github.com/afumu/openlink/releases/latest) 中的 `extension.zip` 并解压
2. 打开 Chrome，访问 `chrome://extensions/`
3. 开启右上角「开发者模式」
4. 点击「加载已解压的扩展程序」，选择解压后的目录

### 第三步：连接扩展与服务

1. 点击浏览器工具栏中的 OpenLink 图标
2. 将终端输出的认证 URL 粘贴到「API 地址」输入框
3. 点击保存

### 第四步：开始使用

访问 [Gemini](https://gemini.google.com) 或 [AI Studio](https://aistudio.google.com)，点击页面右下角的「🔗 初始化」按钮，AI 即可开始使用本地工具。

---

## 推荐平台

> **目前测试效果最佳的平台是 [Google AI Studio](https://aistudio.google.com)**
>
> AI Studio 原生支持配置系统提示词（System Instructions），点击「🔗 初始化」后会自动将工具说明写入系统提示词，无需占用对话上下文，工具调用更稳定、更准确。
>
> 其他平台通过对话消息注入提示词，效果因模型而异。

## 支持的 AI 平台

| 平台 | 状态 | 备注 |
|------|------|------|
| Google AI Studio | ✅ | 推荐，原生支持系统提示词 |
| Google Gemini | ✅ | |

---

## 可用工具

| 工具 | 说明 |
|------|------|
| `exec_cmd` | 执行 Shell 命令 |
| `list_dir` | 列出目录内容 |
| `read_file` | 读取文件内容（支持分页） |
| `write_file` | 写入文件内容（支持追加/覆盖） |
| `glob` | 按文件名模式搜索文件 |
| `grep` | 正则搜索文件内容 |
| `edit` | 精确替换文件中的字符串 |
| `web_fetch` | 获取网页内容 |
| `question` | 向用户提问并等待回答 |
| `skill` | 加载自定义 Skill |
| `todo_write` | 写入待办事项 |

## 输入框快捷补全

在任意支持的 AI 平台输入框中，OpenLink 提供两种快捷触发：

| 触发方式 | 效果 |
|----------|------|
| 输入 `/` | 弹出当前项目所有 Skills 列表，选择后自动插入工具调用 XML |
| 输入 `@` | 弹出工作目录文件路径补全列表，选择后插入文件路径 |

**操作方式：**
- ↑ / ↓ 键盘导航
- Enter 确认选择
- Escape 或点击外部关闭

---

## Skills 扩展

Skills 是放在本地的 Markdown 文件，AI 可以按需加载，用于扩展特定领域的能力（如部署流程、代码规范、项目约定等）。

### Skills 目录（按优先级）

OpenLink 会依次扫描以下目录，同名 Skill 以先找到的为准：

```
<工作目录>/.skills/
<工作目录>/.openlink/skills/
<工作目录>/.agent/skills/
<工作目录>/.claude/skills/
~/.openlink/skills/
~/.agent/skills/
~/.claude/skills/
```

### 创建 Skill

在任意 Skills 目录下创建子目录，并在其中放置 `SKILL.md`：

```
.skills/
└── deploy/
    └── SKILL.md
```

`SKILL.md` 格式：

```markdown
---
name: deploy
description: 项目部署流程
---

## 部署步骤
...
```

AI 通过 `skill` 工具加载：

```
<tool name="skill">
  <parameter name="skill">deploy</parameter>
</tool>
```

---

## 安全机制

- **沙箱隔离**：所有文件操作限制在指定工作目录内
- **危险命令拦截**：`rm -rf`、`sudo`、`curl` 等命令被屏蔽
- **超时控制**：命令执行默认 60 秒超时

---

## 命令行参数

```bash
openlink [选项]

选项：
  -dir string    工作目录（默认：当前目录）
  -port int      监听端口（默认：39527）
  -timeout int   命令超时秒数（默认：60）
```

---

## 从源码构建

详见 [docs/development.md](docs/development.md)

---

## 问题反馈

[提交 Issue](https://github.com/afumu/openlink/issues)

## 交流群

欢迎加微信交流，备注 `openlink`：

**微信号：afumudev**

---

## 致谢

本项目在开发过程中参考了以下优秀的开源项目：

- [opencode](https://github.com/anomalyco/opencode)
- [MCP-SuperAssistant](https://github.com/srbhptl39/MCP-SuperAssistant)
- [learn-claude-code](https://github.com/shareAI-lab/learn-claude-code)

感谢这些项目的作者和贡献者。

---

## 免责声明

本项目仅供学习和研究使用，**严禁用于任何商业用途**。
