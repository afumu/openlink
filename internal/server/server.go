package server

import (
	"context"
	"crypto/subtle"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"github.com/afumu/openlink/internal/executor"
	"github.com/afumu/openlink/internal/security"
	"github.com/afumu/openlink/internal/types"
	"github.com/gin-gonic/gin"
)

type Server struct {
	config   *types.Config
	router   *gin.Engine
	executor *executor.Executor
}

func New(config *types.Config) *Server {
	gin.SetMode(gin.ReleaseMode)
	router := gin.Default()

	s := &Server{
		config:   config,
		router:   router,
		executor: executor.New(config),
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

func (s *Server) handlePrompt(c *gin.Context) {
	content, err := os.ReadFile(filepath.Join(s.config.RootDir, "init_prompt.txt"))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "init_prompt.txt not found"})
		return
	}
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

	resp := s.executor.Execute(context.Background(), &req)

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
