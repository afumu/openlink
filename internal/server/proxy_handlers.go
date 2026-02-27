package server

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/afumu/openlink/internal/proxy"
	"github.com/afumu/openlink/internal/types"
	"github.com/gin-gonic/gin"
)

const proxyTimeout = 5 * time.Minute

// extractPrompt 把 messages 数组拼成纯文本填入 AI 对话框。
// 注意：这会把多轮对话历史压缩成单条消息，AI 平台无法区分轮次。
// 对于单轮问答（如 Cursor 的单次请求）效果良好；多轮 agentic 场景效果有限。
func extractPrompt(msgs []types.OpenAIChatMessage) string {
	var sb strings.Builder
	for _, m := range msgs {
		switch m.Role {
		case "system":
			sb.WriteString("[System]: ")
		case "user":
			sb.WriteString("[User]: ")
		case "assistant":
			sb.WriteString("[Assistant]: ")
		default:
			sb.WriteString("[" + m.Role + "]: ")
		}
		sb.WriteString(m.Content)
		sb.WriteString("\n\n")
	}
	return strings.TrimSpace(sb.String())
}

// handleOpenAIChat 处理 POST /v1/chat/completions
func (s *Server) handleOpenAIChat(c *gin.Context) {
	var req types.OpenAIChatRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	prompt := extractPrompt(req.Messages)
	proxyReq, err := s.proxyMgr.Submit("openai", prompt)
	if err == proxy.ErrNoClient {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "browser extension not connected"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	log.Printf("[Proxy] OpenAI 请求 id=%s, prompt长度=%d", proxyReq.ID, len(prompt))

	reply, err := s.proxyMgr.WaitReply(proxyReq, proxyTimeout)
	if err != nil {
		c.JSON(http.StatusGatewayTimeout, gin.H{"error": "browser did not reply in time"})
		return
	}

	model := req.Model
	if model == "" {
		model = "browser-proxy"
	}
	c.JSON(http.StatusOK, types.OpenAIChatResponse{
		ID:      "chatcmpl-" + proxyReq.ID,
		Object:  "chat.completion",
		Created: time.Now().Unix(),
		Model:   model,
		Choices: []types.OpenAIChoice{
			{
				Index:        0,
				Message:      types.OpenAIChatMessage{Role: "assistant", Content: reply},
				FinishReason: "stop",
			},
		},
		Usage: types.OpenAIUsage{},
	})
}

// handleAnthropicMessages 处理 POST /v1/messages
func (s *Server) handleAnthropicMessages(c *gin.Context) {
	var req types.AnthropicRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var oaiMsgs []types.OpenAIChatMessage
	if req.System != "" {
		oaiMsgs = append(oaiMsgs, types.OpenAIChatMessage{Role: "system", Content: req.System})
	}
	for _, m := range req.Messages {
		oaiMsgs = append(oaiMsgs, types.OpenAIChatMessage{Role: m.Role, Content: m.Content})
	}
	prompt := extractPrompt(oaiMsgs)

	proxyReq, err := s.proxyMgr.Submit("anthropic", prompt)
	if err == proxy.ErrNoClient {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"type":  "error",
			"error": gin.H{"type": "overloaded_error", "message": "browser extension not connected"},
		})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	log.Printf("[Proxy] Anthropic 请求 id=%s, prompt长度=%d", proxyReq.ID, len(prompt))

	reply, err := s.proxyMgr.WaitReply(proxyReq, proxyTimeout)
	if err != nil {
		c.JSON(http.StatusGatewayTimeout, gin.H{
			"type":  "error",
			"error": gin.H{"type": "overloaded_error", "message": "timeout"},
		})
		return
	}

	model := req.Model
	if model == "" {
		model = "browser-proxy"
	}
	c.JSON(http.StatusOK, types.AnthropicResponse{
		ID:         "msg_" + proxyReq.ID,
		Type:       "message",
		Role:       "assistant",
		Content:    []types.AnthropicContent{{Type: "text", Text: reply}},
		Model:      model,
		StopReason: "end_turn",
		Usage:      types.AnthropicUsage{},
	})
}

// handleSSE 插件建立 SSE 长连接，接收待处理的 LLM 请求
func (s *Server) handleSSE(c *gin.Context) {
	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.Header().Set("Connection", "keep-alive")
	c.Writer.Header().Set("X-Accel-Buffering", "no")

	eventCh, unregister := s.proxyMgr.RegisterSSEClient()
	defer unregister()

	log.Println("[Proxy] SSE 客户端已连接")

	fmt.Fprintf(c.Writer, "event: connected\ndata: {}\n\n")
	c.Writer.Flush()

	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-c.Request.Context().Done():
			log.Println("[Proxy] SSE 客户端断开")
			return
		case evt := <-eventCh:
			data, _ := json.Marshal(evt)
			fmt.Fprintf(c.Writer, "event: proxy_request\ndata: %s\n\n", data)
			c.Writer.Flush()
			log.Printf("[Proxy] SSE 推送 request_id=%s", evt.RequestID)
		case <-ticker.C:
			fmt.Fprintf(c.Writer, ": heartbeat\n\n")
			c.Writer.Flush()
		}
	}
}

// handleProxyReply 插件回传 AI 回复内容
func (s *Server) handleProxyReply(c *gin.Context) {
	var reply types.ProxyReply
	if err := c.ShouldBindJSON(&reply); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if reply.RequestID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "request_id required"})
		return
	}

	ok := s.proxyMgr.Deliver(reply.RequestID, reply.Content)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "request not found or already expired"})
		return
	}

	log.Printf("[Proxy] 收到回复 request_id=%s, 长度=%d", reply.RequestID, len(reply.Content))
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
