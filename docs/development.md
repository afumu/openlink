# 开发指南

## 环境要求

- Go 1.23+
- Node.js 18+
- Chrome 浏览器

## 项目结构

```
openlink/
├── cmd/server/          # 服务端入口
├── internal/
│   ├── executor/        # 工具执行器
│   ├── security/        # 沙箱与 Token
│   ├── server/          # HTTP 服务
│   └── types/           # 公共类型
├── prompts/             # 内置初始化提示词
├── extension/           # Chrome 扩展（Vite + React）
│   ├── src/
│   │   ├── content/     # 内容脚本（工具调用拦截）
│   │   ├── popup/       # 扩展弹窗 UI
│   │   └── background/  # Service Worker
│   └── public/          # manifest.json 等静态资源
├── install.sh           # Linux/macOS 安装脚本
├── install.ps1          # Windows 安装脚本
└── .goreleaser.yml      # 多平台发布配置
```

## 本地开发

### 启动服务端

```bash
go run cmd/server/main.go -dir=/your/workspace
```

### 构建服务端

```bash
go build -o openlink cmd/server/main.go
```

### 开发扩展

```bash
cd extension
npm install
npm run build      # 生产构建
npm run dev        # 监听模式（改动自动重新构建）
```

构建产物在 `extension/dist/`，在 Chrome 中加载该目录即可。

### 运行测试

```bash
go test ./...
```

## 发布新版本

推送 tag 后 GitHub Actions 自动构建并发布：

```bash
git tag v1.0.0
git push origin v1.0.0
```

发布产物包含：
- 各平台二进制（linux/darwin/windows × amd64/arm64）
- 扩展压缩包 `extension.zip`

## 添加新 AI 平台支持

在 `extension/src/content/index.ts` 的 `getSiteConfig()` 中添加新站点配置：

```typescript
if (h.includes('example.com'))
  return {
    editor: 'textarea#input',          // 输入框选择器
    sendBtn: 'button[type="submit"]',  // 发送按钮选择器
    stopBtn: null,
    fillMethod: 'value',               // paste | execCommand | value | prosemirror
    useObserver: true,                 // 是否用 DOM Observer 检测工具调用
    responseSelector: '.response',    // 响应容器选择器（useObserver=true 时必填）
    supported: true,                   // 显示初始化按钮
  };
```

同时在 `extension/public/manifest.json` 的 `content_scripts.matches` 和 `web_accessible_resources.matches` 中添加对应域名。

## 添加新工具

在 `internal/executor/executor.go` 的 `Execute` 方法中添加新的 `case`，并在 `ListTools()` 中注册工具信息。所有文件路径操作必须通过 `security.SafePath()` 验证。
