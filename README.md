# Ground-Link

浏览器本地代理 - 让网页版 AI 访问本地文件系统

## 快速开始

### 1. 启动 Go Server

```bash
cd openlink
go run cmd/server/main.go -dir=/your/workspace -port=8080
```

### 2. 加载浏览器插件

1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择 `extension` 目录

### 3. 使用

1. 访问 DeepSeek/ChatGPT/Claude
2. 让 AI 输出包含 `<tool>` 标签的指令
3. 插件会弹出确认框
4. 点击"运行"执行本地操作

## 支持的工具

- `list_dir`: 列出目录
- `read_file`: 读取文件
- `write_file`: 写入文件
- `exec_cmd`: 执行命令

## 安全特性

✅ 沙箱隔离 - 只能访问指定目录
✅ 危险命令拦截
✅ 人工确认机制
✅ 超时控制
