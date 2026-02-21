# Ground-Link 工具扩展实施方案 v2（含 Windows 兼容）

## 背景

当前 ground-link 只有 4 个工具：`exec_cmd`、`read_file`、`write_file`、`list_dir`。
目标：添加 `invalid`、`glob`、`grep`、`edit`、`web_fetch`、`todo_write`、`question`、`skill`，
修复安全漏洞，统一截断逻辑，全平台兼容（macOS / Linux / Windows）。

---

## Windows 兼容核心原则

从 opencode 源码提炼的关键 Windows 差异：

| 问题 | opencode 的处理方式 | ground-link 的对应方案 |
|------|-------------------|----------------------|
| 路径分隔符 | `path.sep`、`path.join` | `filepath.Join`（Go 自动处理） |
| 行尾符 `\r\n` | `text.split(/\r?\n/)` | `strings.Split` 前先 `strings.ReplaceAll(s, "\r\n", "\n")` |
| Shell 选择 | Win32 用 `cmd.exe` 或 Git Bash | `exec_cmd` 检测 `COMSPEC` 或 fallback `cmd.exe` |
| 进程终止 | Win32 用 `taskkill /pid /f /t` | `exec_cmd` timeout 用 `cmd.Process.Kill()`（Go 跨平台） |
| 用户主目录 | `os.homedir()` | `os.UserHomeDir()`（Go 跨平台） |
| 文件权限 | `chmod` 仅 non-win32 | `os.WriteFile` 在 Windows 忽略 mode 位，无需特殊处理 |
| grep 命令 | 调用 ripgrep 二进制 | 优先系统 `rg`，fallback Go 原生实现（Windows 无内置 grep） |
| glob 文件遍历 | ripgrep `--files` | `filepath.WalkDir`（Go 跨平台） |

---

## 基础设施改进

### I-1: 修复 SafePath symlink 漏洞
**文件**: `internal/security/sandbox.go`

```go
func SafePath(rootDir, targetPath string) (string, error) {
    absRoot, err := filepath.Abs(rootDir)
    if err != nil {
        return "", err
    }
    joined := filepath.Join(rootDir, targetPath)
    // EvalSymlinks 解析符号链接；文件不存在时（新建场景）fallback 到 Abs
    absTarget, err := filepath.EvalSymlinks(joined)
    if err != nil {
        absTarget, err = filepath.Abs(joined)
        if err != nil {
            return "", err
        }
    }
    if !strings.HasPrefix(absTarget, absRoot+string(filepath.Separator)) && absTarget != absRoot {
        return "", errors.New("path outside sandbox")
    }
    return absTarget, nil
}
```

**Windows 注意**：`filepath.EvalSymlinks` 和 `filepath.Abs` 在 Windows 均返回反斜杠路径，`strings.HasPrefix` 比较正确。

**改动量**: ~8 行替换

---

### I-2: 统一截断逻辑
**新文件**: `internal/tool/truncate.go`

截断内容写入 `~/.ground-link/tool-output/<timestamp>`，返回预览+提示。

```go
package tool

import (
    "fmt"
    "os"
    "path/filepath"
    "strings"
    "time"
)

const MaxLines = 2000
const MaxBytes = 50 * 1024

func Truncate(output string) (string, bool) {
    // 统一行尾符（Windows \r\n → \n）
    normalized := strings.ReplaceAll(output, "\r\n", "\n")
    lines := strings.Split(normalized, "\n")

    if len(lines) <= MaxLines && len(normalized) <= MaxBytes {
        return output, false
    }

    // 截取预览
    end := MaxLines
    if end > len(lines) {
        end = len(lines)
    }
    preview := strings.Join(lines[:end], "\n")
    if len(preview) > MaxBytes {
        preview = preview[:MaxBytes]
    }

    // 写入完整内容到临时文件（跨平台路径）
    home, _ := os.UserHomeDir()
    dir := filepath.Join(home, ".openlink", "tool-output")
    os.MkdirAll(dir, 0755)
    id := fmt.Sprintf("%d", time.Now().UnixNano())
    fullPath := filepath.Join(dir, id)
    os.WriteFile(fullPath, []byte(output), 0644)

    hint := fmt.Sprintf(
        "\n\n...输出已截断（共 %d 行），完整内容保存至:\n%s\n使用 read_file 工具加 offset 参数分段读取",
        len(lines), fullPath,
    )
    return preview + hint, true
}
```

**改动量**: 新增 ~40 行；`read_file.go` 删除内联截断改调此函数；`exec_cmd.go` 同理

---

### I-3: exec_cmd Windows Shell 兼容
**文件**: `internal/tool/exec_cmd.go`

```go
func getShell() (string, string) {
    if runtime.GOOS == "windows" {
        comspec := os.Getenv("COMSPEC")
        if comspec == "" {
            comspec = "cmd.exe"
        }
        return comspec, "/C"  // cmd.exe /C <command>
    }
    return "sh", "-c"  // sh -c <command>
}

// Execute 中替换:
// exec.CommandContext(execCtx, "sh", "-c", cmd)
// 改为:
shell, flag := getShell()
proc := exec.CommandContext(execCtx, shell, flag, cmd)
```

**改动量**: +8 行，修改 1 行

---

## 新工具详细设计

### T-1: `invalid` 工具
**新文件**: `internal/tool/invalid.go`
**改动**: `internal/executor/executor.go`

捕获所有未知工具名，给 AI 明确反馈。同时修复大小写不敏感路由。

```go
// invalid.go
type InvalidTool struct{}

func (t *InvalidTool) Name() string        { return "invalid" }
func (t *InvalidTool) Description() string { return "Catches unknown tool calls" }
func (t *InvalidTool) Parameters() interface{} { return nil }
func (t *InvalidTool) Validate(args map[string]interface{}) error { return nil }
func (t *InvalidTool) Execute(ctx *Context) *Result {
    toolName, _ := ctx.Args["tool"].(string)
    return &Result{
        Status: "error",
        Error:  fmt.Sprintf("工具 '%s' 不存在。可用工具: exec_cmd, read_file, write_file, list_dir, glob, grep, edit, web_fetch, todo_write, question, skill", toolName),
    }
}
```

**executor.go 改动**（大小写不敏感 + 路由到 invalid）:
```go
t, exists := e.registry.Get(req.Name)
if !exists {
    // 尝试小写（AI 有时输出 Bash 而非 bash）
    t, exists = e.registry.Get(strings.ToLower(req.Name))
}
if !exists {
    t, _ = e.registry.Get("invalid")
    req.Args = map[string]interface{}{"tool": req.Name}
}
```

**改动量**: 新增 ~25 行；executor.go 改 ~8 行

---

### T-2: `todo_write` 工具
**新文件**: `internal/tool/todo_write.go`

AI 维护任务列表，每次传完整列表覆盖写入 `{rootDir}/.todos.json`。

**参数**:
```json
{
  "name": "todo_write",
  "args": {
    "todos": [
      {"id": "1", "content": "实现登录功能", "status": "in_progress", "priority": "high"},
      {"id": "2", "content": "写单元测试", "status": "pending", "priority": "medium"}
    ]
  }
}
```

```go
func (t *TodoWriteTool) Execute(ctx *Context) *Result {
    todos := ctx.Args["todos"]
    data, err := json.MarshalIndent(todos, "", "  ")
    if err != nil {
        return &Result{Status: "error", Error: err.Error()}
    }
    // filepath.Join 在 Windows 自动用反斜杠
    path := filepath.Join(ctx.Config.RootDir, ".todos.json")
    if err := os.WriteFile(path, data, 0644); err != nil {
        return &Result{Status: "error", Error: err.Error()}
    }
    items, _ := todos.([]interface{})
    return &Result{Status: "success", Output: fmt.Sprintf("已保存 %d 个任务", len(items))}
}
```

**改动量**: 新增 ~40 行

---

### T-3: `glob` 工具
**新文件**: `internal/tool/glob.go`

文件模式匹配，按修改时间排序，最多 100 条。

**参数**:
```json
{"name": "glob", "args": {"pattern": "**/*.go", "path": "internal/"}}
```

**Windows 兼容**：
- 用 `filepath.WalkDir` 而非 shell `find`
- 用 `filepath.Match` 做模式匹配（不支持 `**`），对 `**` 模式降级为递归遍历所有文件再过滤文件名
- 路径输出用 `filepath.ToSlash` 统一为正斜杠（AI 更易理解）

```go
func (t *GlobTool) Execute(ctx *Context) *Result {
    pattern, _ := ctx.Args["pattern"].(string)
    searchPath, _ := ctx.Args["path"].(string)
    if searchPath == "" {
        searchPath = "."
    }

    safePath, err := security.SafePath(ctx.Config.RootDir, searchPath)
    if err != nil {
        return &Result{Status: "error", Error: err.Error()}
    }

    type fileEntry struct {
        path  string
        mtime time.Time
    }
    var files []fileEntry

    // 提取文件名模式（用于 filepath.Match）
    basePat := filepath.Base(pattern)
    isRecursive := strings.Contains(pattern, "**")

    filepath.WalkDir(safePath, func(p string, d fs.DirEntry, err error) error {
        if err != nil || d.IsDir() {
            return nil
        }
        name := d.Name()
        matched, _ := filepath.Match(basePat, name)
        if !matched && isRecursive {
            // ** 模式：匹配任意路径下的文件名
            matched, _ = filepath.Match(basePat, name)
        }
        if matched {
            info, _ := d.Info()
            files = append(files, fileEntry{
                path:  filepath.ToSlash(p),  // 统一正斜杠
                mtime: info.ModTime(),
            })
        }
        return nil
    })

    // 按修改时间降序排序
    sort.Slice(files, func(i, j int) bool {
        return files[i].mtime.After(files[j].mtime)
    })

    const limit = 100
    truncated := len(files) > limit
    if truncated {
        files = files[:limit]
    }

    var lines []string
    for _, f := range files {
        lines = append(lines, f.path)
    }
    if truncated {
        lines = append(lines, fmt.Sprintf("\n(结果已截断，仅显示前 %d 条，请使用更精确的 pattern 或 path)", limit))
    }
    if len(lines) == 0 {
        return &Result{Status: "success", Output: "No files found"}
    }
    return &Result{Status: "success", Output: strings.Join(lines, "\n")}
}
```

**改动量**: 新增 ~65 行

---

### T-4: `grep` 工具
**新文件**: `internal/tool/grep.go`

正则内容搜索，支持文件过滤，最多 100 条匹配。

**参数**:
```json
{"name": "grep", "args": {"pattern": "func.*Handler", "path": "internal/", "include": "*.go"}}
```

**Windows 兼容**（关键）：
- Windows 无内置 `grep`，不能直接调用
- 策略：优先调用系统 `rg`（ripgrep，跨平台），fallback Go 原生 `regexp` + `filepath.WalkDir`
- 检测 `rg` 是否存在：`exec.LookPath("rg")`

```go
func (t *GrepTool) Execute(ctx *Context) *Result {
    pattern, _ := ctx.Args["pattern"].(string)
    searchPath, _ := ctx.Args["path"].(string)
    include, _ := ctx.Args["include"].(string)
    if searchPath == "" {
        searchPath = "."
    }

    safePath, err := security.SafePath(ctx.Config.RootDir, searchPath)
    if err != nil {
        return &Result{Status: "error", Error: err.Error()}
    }

    // 优先用 rg（跨平台，Windows/macOS/Linux 均可用）
    if rgPath, err := exec.LookPath("rg"); err == nil {
        return t.grepWithRg(rgPath, pattern, safePath, include)
    }
    // fallback: Go 原生实现（Windows 无 grep 时使用）
    return t.grepNative(pattern, safePath, include)
}

func (t *GrepTool) grepWithRg(rgPath, pattern, searchPath, include string) *Result {
    args := []string{"-n", "--no-heading", pattern, searchPath}
    if include != "" {
        args = append([]string{"--glob", include}, args...)
    }
    cmd := exec.Command(rgPath, args...)
    output, _ := cmd.Output()
    return t.formatOutput(pattern, string(output))
}

func (t *GrepTool) grepNative(pattern, searchPath, include string) *Result {
    re, err := regexp.Compile(pattern)
    if err != nil {
        return &Result{Status: "error", Error: "invalid pattern: " + err.Error()}
    }
    // WalkDir + 逐行匹配
    // ...
}
```

**改动量**: 新增 ~90 行

---

### T-5: `edit` 工具
**新文件**: `internal/tool/edit.go`

精确字符串替换，区别于 `write_file` 全量覆盖。

**参数**:
```json
{
  "name": "edit",
  "args": {
    "path": "internal/server/server.go",
    "old_string": "func (s *Server) handleHealth(",
    "new_string": "func (s *Server) handleHealthCheck(",
    "replace_all": false
  }
}
```

**Windows 兼容**（关键）：
- 文件可能含 `\r\n`（Windows 行尾），AI 生成的 `old_string` 通常是 `\n`
- 读取文件后先 normalize，替换后写回时保留原始行尾风格

```go
func replace(content, oldStr, newStr string, replaceAll bool) (string, error) {
    // 策略1: 精确匹配（含原始行尾符）
    if strings.Contains(content, oldStr) {
        if replaceAll {
            return strings.ReplaceAll(content, oldStr, newStr), nil
        }
        return strings.Replace(content, oldStr, newStr, 1), nil
    }

    // 策略2: normalize 行尾后匹配（处理 \r\n vs \n 差异）
    normalContent := strings.ReplaceAll(content, "\r\n", "\n")
    normalOld := strings.ReplaceAll(oldStr, "\r\n", "\n")
    if strings.Contains(normalContent, normalOld) {
        normalNew := strings.ReplaceAll(newStr, "\r\n", "\n")
        var result string
        if replaceAll {
            result = strings.ReplaceAll(normalContent, normalOld, normalNew)
        } else {
            result = strings.Replace(normalContent, normalOld, normalNew, 1)
        }
        // 若原文件是 \r\n，写回时恢复
        if strings.Contains(content, "\r\n") {
            result = strings.ReplaceAll(result, "\n", "\r\n")
        }
        return result, nil
    }

    // 策略3: 行级 trim 匹配（处理 AI 生成的缩进差异）
    return lineTrimReplace(content, oldStr, newStr, replaceAll)
}
```

**改动量**: 新增 ~90 行

---

### T-6: `web_fetch` 工具
**新文件**: `internal/tool/web_fetch.go`

用 Go `net/http` 直接请求，不走 shell，不受 `IsDangerousCommand` 黑名单限制。

**参数**:
```json
{"name": "web_fetch", "args": {"url": "https://pkg.go.dev/net/http", "format": "text"}}
```

**Windows 兼容**：Go `net/http` 完全跨平台，无需特殊处理。

```go
func (t *WebFetchTool) Execute(ctx *Context) *Result {
    url, _ := ctx.Args["url"].(string)
    format, _ := ctx.Args["format"].(string)

    if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
        return &Result{Status: "error", Error: "只支持 http/https URL"}
    }

    client := &http.Client{Timeout: 30 * time.Second}
    resp, err := client.Get(url)
    if err != nil {
        return &Result{Status: "error", Error: err.Error()}
    }
    defer resp.Body.Close()

    body, err := io.ReadAll(io.LimitReader(resp.Body, 1*1024*1024)) // 最大 1MB
    if err != nil {
        return &Result{Status: "error", Error: err.Error()}
    }

    content := string(body)
    if format != "html" {
        content = stripHTML(content)
    }

    output, _ := Truncate(content)
    return &Result{Status: "success", Output: output}
}

var htmlTagRe = regexp.MustCompile(`<[^>]+>`)
var multiSpaceRe = regexp.MustCompile(`\s{3,}`)

func stripHTML(s string) string {
    s = htmlTagRe.ReplaceAllString(s, "")
    s = multiSpaceRe.ReplaceAllString(s, "\n\n")
    return strings.TrimSpace(s)
}
```

**改动量**: 新增 ~55 行

---

### T-7: `question` 工具
**新文件**: `internal/tool/question.go`

**设计理解**：
- AI 调用 `question` → 服务端**立即返回**问题文本
- content.ts 把文本填入浏览器输入框并发送给 AI
- AI 把问题展示给用户
- 用户在网页端手动输入答案 → AI 收到后继续执行
- **完全无状态，无需 SSE，无需挂起**

**参数**:
```json
{
  "name": "question",
  "args": {
    "question": "您希望将文件写入哪个目录？",
    "options": ["src/", "lib/", "自定义路径"]
  }
}
```

```go
func (t *QuestionTool) Execute(ctx *Context) *Result {
    question, _ := ctx.Args["question"].(string)
    options, _ := ctx.Args["options"].([]interface{})

    output := fmt.Sprintf("[需要您的输入]\n\n%s", question)
    if len(options) > 0 {
        output += "\n\n可选项："
        for i, opt := range options {
            output += fmt.Sprintf("\n  %d. %v", i+1, opt)
        }
        output += "\n\n请输入您的选择或回答："
    }
    return &Result{Status: "success", Output: output}
}
```

**改动量**: 新增 ~30 行

---

### T-8: `skill` 工具
**新文件**: `internal/tool/skill.go`

读取 `{rootDir}/.skills/<name>.md`，注入工作流指令到对话。

**参数**:
```json
{"name": "skill", "args": {"skill": "code-review"}}
```

**Windows 兼容**：`filepath.Join` 自动处理路径分隔符。

```go
func (t *SkillTool) Execute(ctx *Context) *Result {
    skillName, _ := ctx.Args["skill"].(string)
    if skillName == "" {
        return t.listSkills(ctx)
    }

    skillPath, err := security.SafePath(ctx.Config.RootDir,
        filepath.Join(".skills", skillName+".md"))
    if err != nil {
        return &Result{Status: "error", Error: err.Error()}
    }

    content, err := os.ReadFile(skillPath)
    if err != nil {
        return t.listSkills(ctx) // 找不到时列出可用 skills
    }
    return &Result{Status: "success", Output: string(content)}
}

func (t *SkillTool) listSkills(ctx *Context) *Result {
    skillsDir := filepath.Join(ctx.Config.RootDir, ".skills")
    entries, err := os.ReadDir(skillsDir)
    if err != nil {
        return &Result{Status: "error", Error: "未找到 .skills 目录，请在 rootDir 下创建 .skills/ 目录并放入 .md 文件"}
    }
    var names []string
    for _, e := range entries {
        if !e.IsDir() && strings.HasSuffix(e.Name(), ".md") {
            names = append(names, strings.TrimSuffix(e.Name(), ".md"))
        }
    }
    return &Result{Status: "success", Output: "可用 skills: " + strings.Join(names, ", ")}
}
```

**改动量**: 新增 ~45 行

---

## 配套改动

### executor.go 注册所有新工具

```go
func New(config *types.Config) *Executor {
    e := &Executor{config: config, registry: tool.NewRegistry()}
    // 原有
    e.registry.Register(tool.NewExecCmdTool(config))
    e.registry.Register(tool.NewListDirTool(config))
    e.registry.Register(tool.NewReadFileTool(config))
    e.registry.Register(tool.NewWriteFileTool(config))
    // 新增（invalid 必须注册，用于路由未知工具）
    e.registry.Register(&tool.InvalidTool{})
    e.registry.Register(tool.NewGlobTool(config))
    e.registry.Register(tool.NewGrepTool(config))
    e.registry.Register(tool.NewEditTool(config))
    e.registry.Register(tool.NewWebFetchTool())
    e.registry.Register(tool.NewTodoWriteTool(config))
    e.registry.Register(tool.NewQuestionTool())
    e.registry.Register(tool.NewSkillTool(config))
    return e
}
```

---

## 文件变更总览

| 文件 | 操作 | 关键 Windows 处理 |
|------|------|-----------------|
| `internal/security/sandbox.go` | 修改 | `EvalSymlinks` 跨平台 |
| `internal/tool/truncate.go` | 新增 | `\r\n` normalize，`os.UserHomeDir()` |
| `internal/tool/exec_cmd.go` | 修改 | `COMSPEC`/`cmd.exe` fallback |
| `internal/tool/read_file.go` | 修改 | 调用公共 Truncate |
| `internal/tool/invalid.go` | 新增 | 无 |
| `internal/tool/glob.go` | 新增 | `filepath.WalkDir`，`filepath.ToSlash` |
| `internal/tool/grep.go` | 新增 | 优先 `rg`，fallback Go 原生 |
| `internal/tool/edit.go` | 新增 | `\r\n` 双向 normalize |
| `internal/tool/web_fetch.go` | 新增 | Go `net/http` 跨平台 |
| `internal/tool/todo_write.go` | 新增 | `filepath.Join` |
| `internal/tool/question.go` | 新增 | 无 |
| `internal/tool/skill.go` | 新增 | `filepath.Join` |
| `internal/executor/executor.go` | 修改 | 注册新工具，大小写路由 |

---

## 并行任务分工

```
Task-A  sandbox(I-1) + truncate(I-2) + exec_cmd Windows shell(I-3) + 改造 read_file/exec_cmd
Task-B  invalid(T-1) + todo_write(T-2) + glob(T-3)
Task-C  grep(T-4) + edit(T-5)
Task-D  web_fetch(T-6) + question(T-7) + skill(T-8)
         ↓ 全部完成后
Task-E  executor.go 注册 + go build 编译验证
```

Task-A/B/C/D 完全并行，Task-E 最后串行。
