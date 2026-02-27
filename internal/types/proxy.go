package types

import "time"

// ProxyRequest 是 LLM 代理请求队列中的一个条目
type ProxyRequest struct {
	ID        string    `json:"id"`
	CreatedAt time.Time `json:"created_at"`
	// Format 原始请求格式: "openai" 或 "anthropic"
	Format  string `json:"format"`
	// Prompt 提取出来的纯文本消息（填入对话框的内容）
	Prompt  string `json:"prompt"`
	// ReplyCh 用于唤醒挂起 HTTP 请求的 channel
	ReplyCh chan string `json:"-"`
}

// ProxySSEEvent 是通过 SSE 推送给插件的事件
type ProxySSEEvent struct {
	RequestID string `json:"request_id"`
	Prompt    string `json:"prompt"`
}

// ProxyReply 是插件回传的 AI 回复
type ProxyReply struct {
	RequestID string `json:"request_id"`
	Content   string `json:"content"`
}

// ── OpenAI 兼容格式 ──────────────────────────────────────────────────────────

type OpenAIChatRequest struct {
	Model    string              `json:"model"`
	Messages []OpenAIChatMessage `json:"messages"`
	Stream   bool                `json:"stream"`
}

type OpenAIChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type OpenAIChatResponse struct {
	ID      string         `json:"id"`
	Object  string         `json:"object"`
	Created int64          `json:"created"`
	Model   string         `json:"model"`
	Choices []OpenAIChoice `json:"choices"`
	Usage   OpenAIUsage    `json:"usage"`
}

type OpenAIChoice struct {
	Index        int               `json:"index"`
	Message      OpenAIChatMessage `json:"message"`
	FinishReason string            `json:"finish_reason"`
}

type OpenAIUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// ── Anthropic 兼容格式 ───────────────────────────────────────────────────────

type AnthropicRequest struct {
	Model     string             `json:"model"`
	MaxTokens int                `json:"max_tokens"`
	Messages  []AnthropicMessage `json:"messages"`
	System    string             `json:"system,omitempty"`
}

type AnthropicMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type AnthropicResponse struct {
	ID           string             `json:"id"`
	Type         string             `json:"type"`
	Role         string             `json:"role"`
	Content      []AnthropicContent `json:"content"`
	Model        string             `json:"model"`
	StopReason   string             `json:"stop_reason"`
	StopSequence *string            `json:"stop_sequence"`
	Usage        AnthropicUsage     `json:"usage"`
}

type AnthropicContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type AnthropicUsage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}
