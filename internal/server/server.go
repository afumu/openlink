package server

import (
	"context"
	"crypto/subtle"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/afumu/openlink/internal/executor"
	"github.com/afumu/openlink/internal/proxy"
	"github.com/afumu/openlink/internal/security"
	"github.com/afumu/openlink/internal/skill"
	"github.com/afumu/openlink/internal/types"
	"github.com/gin-gonic/gin"
)

type Server struct {
	config   *types.Config
	router   *gin.Engine
	executor *executor.Executor
	proxyMgr *proxy.Manager
}

func New(config *types.Config) *Server {
	gin.SetMode(gin.ReleaseMode)
	router := gin.Default()

	s := &Server{
		config:   config,
		router:   router,
		executor: executor.New(config),
		proxyMgr: proxy.NewManager(),
	}

	s.setupRoutes()
	return s
}

func (s *Server) setupRoutes() {
	s.router.Use(func(c *gin.Context) {
		c.Writer.Header().Set("Access-Control-Allow-Origin", "*")
		c.Writer.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}
		c.Next()
	})

	s.router.Use(security.AuthMiddleware(s.config.Token))

	s.router.GET("/health", s.handleHealth)
	s.router.POST("/auth", s.handleAuth)
	s.router.GET("/config", s.handleConfig)
	s.router.GET("/tools", s.handleListTools)
	s.router.POST("/exec", s.handleExec)
	s.router.GET("/prompt", s.handlePrompt)
	s.router.GET("/skills", s.handleListSkills)
	s.router.GET("/files", s.handleListFiles)

	// LLM 代理路由
	v1 := s.router.Group("/v1")
	v1.POST("/chat/completions", s.handleOpenAIChat)
	v1.POST("/messages", s.handleAnthropicMessages)
	v1.GET("/sse", s.handleSSE)
	v1.POST("/reply", s.handleProxyReply)
}

func (s *Server) handleHealth(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"status":  "ok",
		"dir":     s.config.RootDir,
		"version": "1.0.0",
	})
}

func (s *Server) handleAuth(c *gin.Context) {
	var req struct {
		Token string `json:"token"`
	}
	if err := c.BindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "invalid request"})
		return
	}

	valid := len(req.Token) == len(s.config.Token) &&
		subtle.ConstantTimeCompare([]byte(req.Token), []byte(s.config.Token)) == 1

	c.JSON(http.StatusOK, gin.H{"valid": valid})
}

func (s *Server) handleConfig(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"rootDir": s.config.RootDir,
		"timeout": s.config.Timeout,
	})
}

func buildSystemInfo(rootDir string) string {
	hostname, _ := os.Hostname()
	return fmt.Sprintf("- 操作系统: %s/%s\n- 工作目录: %s\n- 主机名: %s\n- 当前时间: %s",
		runtime.GOOS, runtime.GOARCH, rootDir, hostname,
		time.Now().Format("2006-01-02 15:04:05"))
}

func (s *Server) handlePrompt(c *gin.Context) {
	content, err := os.ReadFile(filepath.Join(s.config.RootDir, "prompts", "init_prompt.txt"))
	if err != nil {
		if len(s.config.DefaultPrompt) == 0 {
			c.JSON(http.StatusNotFound, gin.H{"error": "init_prompt.txt not found"})
			return
		}
		content = s.config.DefaultPrompt
	}
	content = []byte(strings.ReplaceAll(string(content), "{{SYSTEM_INFO}}", buildSystemInfo(s.config.RootDir)))

	skills := skill.LoadInfos(s.config.RootDir)
	if len(skills) > 0 {
		var sb strings.Builder
		sb.WriteString("\n\n## 当前可用 Skills\n\n")
		for _, sk := range skills {
			sb.WriteString(fmt.Sprintf("- **%s**: %s\n", sk.Name, sk.Description))
		}
		content = append(content, []byte(sb.String())...)
	}

	content = append(content, []byte("\n\n初始化回复：\n你好，我是 openlink，请问有什么可以帮你？")...)

	c.String(http.StatusOK, string(content))
}

func (s *Server) handleListTools(c *gin.Context) {
	tools := s.executor.ListTools()
	c.JSON(http.StatusOK, gin.H{"tools": tools})
}

func (s *Server) handleExec(c *gin.Context) {
	log.Println("[OpenLink] 收到 /exec 请求")

	var req types.ToolRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		log.Printf("[OpenLink] ❌ JSON 解析失败: %v\n", err)
		c.JSON(http.StatusBadRequest, types.ToolResponse{
			Status: "error",
			Error:  err.Error(),
		})
		return
	}

	log.Printf("[OpenLink] 工具调用: name=%s, args=%+v\n", req.Name, req.Args)

	// 修复 AI 模型将换行符误写为 \t 的情况（仅对 edit 工具的字符串参数）
	if req.Name == "edit" {
		for _, key := range []string{"old_string", "new_string"} {
			if v, ok := req.Args[key].(string); ok {
				req.Args[key] = fixTabNewlines(v)
			}
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(s.config.Timeout)*time.Second)
	defer cancel()
	resp := s.executor.Execute(ctx, &req)

	log.Printf("[OpenLink] 执行结果: status=%s, output长度=%d\n", resp.Status, len(resp.Output))
	if resp.Error != "" {
		log.Printf("[OpenLink] 错误信息: %s\n", resp.Error)
	}

	c.JSON(http.StatusOK, resp)
	log.Println("[OpenLink] 响应已发送")
}

func (s *Server) Run() error {
	return s.router.Run(fmt.Sprintf("127.0.0.1:%d", s.config.Port))
}

// fixTabNewlines 修复 AI 模型将换行符误写为 \t 的情况。
// 当 old_string 里不含真正的 \n，但含有 \t 序列时，
// 尝试把行间的 \t 替换为 \n + 原有缩进。
func fixTabNewlines(s string) string {
	// 如果已经含有真正的换行符，说明 AI 输出正常，不做处理
	if strings.Contains(s, "\n") {
		return s
	}
	// 如果不含 \t，也不需要处理
	if !strings.Contains(s, "\t") {
		return s
	}
	// 把每个 \t 替换为 \n\t，模拟换行+缩进
	// 这样 "\t\t\tfoo\t\t\tbar" → "\n\t\t\tfoo\n\t\t\tbar"
	return strings.ReplaceAll(s, "\t", "\n\t")
}

type skillItem struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

func (s *Server) handleListSkills(c *gin.Context) {
	skills := skill.LoadInfos(s.config.RootDir)
	items := make([]skillItem, 0, len(skills))
	for _, sk := range skills {
		items = append(items, skillItem{Name: sk.Name, Description: sk.Description})
	}
	c.JSON(http.StatusOK, gin.H{"skills": items})
}

func (s *Server) handleListFiles(c *gin.Context) {
	q := strings.ToLower(c.Query("q"))
	if len(q) > 200 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "q too long"})
		return
	}
	rootReal, err := filepath.EvalSymlinks(s.config.RootDir)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "invalid root"})
		return
	}
	skipDirs := map[string]bool{
		".git": true, "node_modules": true, ".next": true,
		"dist": true, "build": true, "vendor": true,
	}
	var files []string
	filepath.WalkDir(s.config.RootDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() && skipDirs[d.Name()] {
			return filepath.SkipDir
		}
		if !d.IsDir() {
			real, err := filepath.EvalSymlinks(path)
			if err != nil {
				return nil
			}
			if !strings.HasPrefix(real, rootReal+string(filepath.Separator)) && real != rootReal {
				return nil
			}
			rel, _ := filepath.Rel(s.config.RootDir, path)
			if q == "" || strings.Contains(strings.ToLower(rel), q) {
				files = append(files, rel)
			}
		}
		if len(files) >= 50 {
			return filepath.SkipAll
		}
		return nil
	})
	c.JSON(http.StatusOK, gin.H{"files": files})
}
