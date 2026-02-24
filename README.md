# OpenLink

让网页版 AI（Gemini、通义千问）直接访问你的本地文件系统和执行命令。

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

访问 [Gemini](https://gemini.google.com) 或[通义千问](https://qwen.ai)，点击页面右下角的「🔗 初始化」按钮，AI 即可开始使用本地工具。

---

## 支持的 AI 平台

| 平台 | 状态 |
|------|------|
| Google Gemini | ✅ |
| 通义千问 (Qwen) | ✅ |

---

## 可用工具

| 工具 | 说明 |
|------|------|
| `exec_cmd` | 执行 Shell 命令 |
| `list_dir` | 列出目录内容 |
| `read_file` | 读取文件内容 |
| `write_file` | 写入文件内容 |

---

## 安全机制

- **沙箱隔离**：所有文件操作限制在指定工作目录内
- **危险命令拦截**：`rm -rf`、`sudo`、`curl` 等命令被屏蔽
- **Token 认证**：每次启动生成唯一 Token，防止未授权访问
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
