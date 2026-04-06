package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

type openAIModelInfo struct {
	ID          string `json:"id"`
	Object      string `json:"object"`
	OwnedBy     string `json:"owned_by"`
	Description string `json:"description,omitempty"`
}

var openAIModelCatalog = []openAIModelInfo{
	{ID: "labs-google-fx", Object: "model", OwnedBy: "openlink", Description: "Google Labs Flow image generation via browser automation"},
	{ID: "labs-google-fx-image", Object: "model", OwnedBy: "openlink", Description: "Alias of labs-google-fx for image generation"},
	{ID: "labs-google-fx-video", Object: "model", OwnedBy: "openlink", Description: "Google Labs Flow video generation via browser automation"},
	{ID: "labs-google-fx-veo", Object: "model", OwnedBy: "openlink", Description: "Alias of labs-google-fx-video for video generation"},
	{ID: "gemini-2.0-flash-preview-image-generation", Object: "model", OwnedBy: "openlink", Description: "Gemini image generation via browser automation"},
	{ID: "gemini-2.5-flash-image-preview", Object: "model", OwnedBy: "openlink", Description: "Gemini image generation via browser automation"},
	{ID: "gemini-image", Object: "model", OwnedBy: "openlink", Description: "Alias of Gemini browser image generation"},
}

var markdownImageURLRe = regexp.MustCompile(`!\[[^\]]*\]\(([^)\s]+)`)
var htmlVideoURLRe = regexp.MustCompile(`(?i)<video[^>]+src=['"]([^'"]+)`)

type chatCompletionRequest struct {
	Model           string                  `json:"model"`
	Messages        []chatCompletionMessage `json:"messages"`
	Stream          bool                    `json:"stream"`
	Image           referenceImageInputs    `json:"image"`
	Images          referenceImageInputs    `json:"images"`
	ReferenceImages referenceImageInputs    `json:"reference_images"`
}

type chatCompletionMessage struct {
	Role    string      `json:"role"`
	Content interface{} `json:"content"`
}

func (s *Server) handleOpenAIModels(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"object": "list",
		"data":   openAIModelCatalog,
	})
}

func (s *Server) handleOpenAIChatCompletions(c *gin.Context) {
	var req chatCompletionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	prompt, referenceInputs := extractPromptAndReferencesFromMessages(req.Messages)
	if strings.TrimSpace(prompt) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "messages must contain user text content"})
		return
	}

	model := normalizeOpenAIModel(req.Model)
	mediaKind := openAIModelKind(model)
	ctx, cancel := context.WithTimeout(c.Request.Context(), s.openAITimeoutForKind(mediaKind))
	defer cancel()

	referenceInputs = normalizeReferenceImageInputs(referenceInputs, req.Image, req.Images, req.ReferenceImages)
	referenceImages, err := resolveReferenceImages(ctx, s.config.RootDir, referenceInputs)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid reference images", "details": err.Error()})
		return
	}

	created := time.Now().Unix()
	completionID := fmt.Sprintf("chatcmpl-%d", created)

	if req.Stream {
		job, waiter := s.imageJobBridge.enqueue(openAIModelSite(model), mediaKind, prompt, model, "", "url", referenceImages)
		c.Header("Content-Type", "text/event-stream")
		c.Header("Cache-Control", "no-cache")
		c.Header("Connection", "keep-alive")
		c.Header("X-Accel-Buffering", "no")

		chunk1 := gin.H{
			"id":      completionID,
			"object":  "chat.completion.chunk",
			"created": created,
			"model":   model,
			"choices": []gin.H{{
				"index": 0,
				"delta": gin.H{
					"role": "assistant",
				},
				"finish_reason": nil,
			}},
		}
		writeSSEJSON(c, chunk1)

		statusTextForStage := func(stage string) string {
			switch stage {
			case "queued":
				return fmt.Sprintf("[openlink] %s 任务已排队，等待浏览器接单...\n\n", mediaKind)
			case "in_progress":
				return fmt.Sprintf("[openlink] %s 正在生成中，请稍候...\n\n", mediaKind)
			case "completed":
				return fmt.Sprintf("[openlink] %s 已生成完成，正在返回结果...\n\n", mediaKind)
			default:
				return fmt.Sprintf("[openlink] %s 状态同步中...\n\n", mediaKind)
			}
		}
		writeStatusChunk := func(text string, finishReason interface{}) {
			writeSSEJSON(c, gin.H{
				"id":      completionID,
				"object":  "chat.completion.chunk",
				"created": created,
				"model":   model,
				"choices": []gin.H{{
					"index": 0,
					"delta": gin.H{
						"content": text,
					},
					"finish_reason": finishReason,
				}},
			})
		}

		lastStage := ""
		ticker := time.NewTicker(1500 * time.Millisecond)
		defer ticker.Stop()
		for {
			stage := s.imageJobBridge.jobStage(job.ID)
			if stage != lastStage && stage != "" && stage != "completed" {
				writeStatusChunk(statusTextForStage(stage), nil)
				lastStage = stage
			}

			select {
			case result := <-waiter:
				if result == nil {
					writeStatusChunk(fmt.Sprintf("[openlink] %s 生成失败。\n\n", mediaKind), "stop")
					_, _ = c.Writer.Write([]byte("data: [DONE]\n\n"))
					c.Writer.Flush()
					return
				}
				if lastStage != "completed" {
					writeStatusChunk(statusTextForStage("completed"), nil)
				}
				mediaURL := buildGeneratedAssetURL(c, result.StoredRelPath, s.config.Token)
				content := buildOpenAIMediaContent(mediaKind, mediaURL)
				writeStatusChunk(content, "stop")
				_, _ = c.Writer.Write([]byte("data: [DONE]\n\n"))
				c.Writer.Flush()
				return
			case <-ticker.C:
				stage = s.imageJobBridge.jobStage(job.ID)
				if stage != lastStage && stage != "" && stage != "completed" {
					writeStatusChunk(statusTextForStage(stage), nil)
					lastStage = stage
				}
			case <-ctx.Done():
				c.SSEvent("error", gin.H{"error": fmt.Sprintf("%s generation timed out", mediaKind)})
				_, _ = c.Writer.Write([]byte("data: [DONE]\n\n"))
				c.Writer.Flush()
				return
			case <-c.Request.Context().Done():
				return
			}
		}
	}

	job, result, err := s.imageJobBridge.enqueueAndWait(ctx, openAIModelSite(model), mediaKind, prompt, model, "", "url", referenceImages)
	if err != nil {
		c.JSON(http.StatusGatewayTimeout, gin.H{"error": fmt.Sprintf("%s generation timed out", mediaKind), "details": err.Error()})
		return
	}

	mediaURL := buildGeneratedAssetURL(c, result.StoredRelPath, s.config.Token)
	content := buildOpenAIMediaContent(mediaKind, mediaURL)

	c.JSON(http.StatusOK, gin.H{
		"id":      completionID,
		"object":  "chat.completion",
		"created": created,
		"model":   model,
		"choices": []gin.H{{
			"index": 0,
			"message": gin.H{
				"role":    "assistant",
				"content": content,
			},
			"finish_reason": "stop",
		}},
		"usage": gin.H{
			"prompt_tokens":     0,
			"completion_tokens": 0,
			"total_tokens":      0,
		},
		"revised_prompt": job.Prompt,
		"url":            mediaURL,
	})
}

func extractPromptAndReferencesFromMessages(messages []chatCompletionMessage) (string, []referenceImageInput) {
	if len(messages) == 0 {
		return "", nil
	}

	lastUserIndex := -1
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == "user" {
			lastUserIndex = i
			break
		}
	}
	if lastUserIndex == -1 {
		return "", nil
	}

	prompt, references := extractPromptAndReferencesFromContent(messages[lastUserIndex].Content)
	references = appendHistoricalAssistantReferenceImages(references, messages[:lastUserIndex])
	return prompt, references
}

func extractPromptAndReferencesFromContent(content interface{}) (string, []referenceImageInput) {
	var parts []string
	var references []referenceImageInput
	appendChatContent(content, &parts, &references)
	return strings.Join(parts, "\n\n"), references
}

func extractTextFromChatContent(content interface{}) string {
	var parts []string
	appendTextOnly(content, &parts)
	return strings.Join(parts, "\n\n")
}

func appendTextOnly(content interface{}, parts *[]string) {
	switch value := content.(type) {
	case string:
		if text := strings.TrimSpace(value); text != "" {
			*parts = append(*parts, text)
		}
	case []interface{}:
		for _, item := range value {
			appendTextOnly(item, parts)
		}
	case map[string]interface{}:
		if text, ok := value["text"].(string); ok && strings.TrimSpace(text) != "" {
			*parts = append(*parts, strings.TrimSpace(text))
		}
		if rawContent, ok := value["content"]; ok {
			appendTextOnly(rawContent, parts)
		}
	}
}

func appendChatContent(content interface{}, parts *[]string, references *[]referenceImageInput) {
	switch value := content.(type) {
	case string:
		if text := strings.TrimSpace(value); text != "" {
			*parts = append(*parts, text)
		}
	case []interface{}:
		for _, item := range value {
			appendChatContent(item, parts, references)
		}
	case map[string]interface{}:
		appendChatContentItem(value, parts, references)
	}
}

func appendChatContentItem(item map[string]interface{}, parts *[]string, references *[]referenceImageInput) {
	itemType, _ := item["type"].(string)
	switch itemType {
	case "", "text", "input_text":
		if text, ok := item["text"].(string); ok && strings.TrimSpace(text) != "" {
			*parts = append(*parts, strings.TrimSpace(text))
		}
	case "image_url", "input_image":
		if ref := extractReferenceImageFromChatItem(item); ref.URL != "" || ref.Path != "" || ref.Data != "" {
			*references = append(*references, ref)
		}
	}
}

func extractReferenceImageFromChatItem(item map[string]interface{}) referenceImageInput {
	if raw, ok := item["file_data"]; ok {
		switch value := raw.(type) {
		case string:
			return referenceImageInputFromString(value)
		case map[string]interface{}:
			return referenceImageInputFromMap(map[string]any(value))
		}
	}
	if raw, ok := item["fileData"]; ok {
		switch value := raw.(type) {
		case string:
			return referenceImageInputFromString(value)
		case map[string]interface{}:
			return referenceImageInputFromMap(map[string]any(value))
		}
	}
	if raw, ok := item["image_url"]; ok {
		switch value := raw.(type) {
		case string:
			return referenceImageInputFromString(value)
		case map[string]interface{}:
			return referenceImageInputFromMap(map[string]any(value))
		}
	}
	if raw, ok := item["input_image"]; ok {
		switch value := raw.(type) {
		case string:
			return referenceImageInputFromString(value)
		case map[string]interface{}:
			return referenceImageInputFromMap(map[string]any(value))
		}
	}
	return referenceImageInputFromMap(map[string]any(item))
}

func appendHistoricalAssistantReferenceImages(references []referenceImageInput, messages []chatCompletionMessage) []referenceImageInput {
	for i := len(messages) - 1; i >= 0; i-- {
		msg := messages[i]
		if msg.Role != "assistant" {
			continue
		}
		content := extractTextFromChatContent(msg.Content)
		if strings.TrimSpace(content) == "" {
			continue
		}
		matches := markdownImageURLRe.FindAllStringSubmatch(content, -1)
		if len(matches) == 0 {
			videoMatches := htmlVideoURLRe.FindAllStringSubmatch(content, -1)
			if len(videoMatches) == 0 {
				continue
			}
			for j := len(videoMatches) - 1; j >= 0; j-- {
				videoURL := strings.TrimSpace(videoMatches[j][1])
				if videoURL == "" {
					continue
				}
				return append([]referenceImageInput{referenceImageInputFromString(videoURL)}, references...)
			}
			continue
		}
		for j := len(matches) - 1; j >= 0; j-- {
			imageURL := strings.TrimSpace(matches[j][1])
			if imageURL == "" {
				continue
			}
			return append([]referenceImageInput{referenceImageInputFromString(imageURL)}, references...)
		}
	}
	return references
}

func normalizeOpenAIModel(model string) string {
	model = strings.TrimSpace(model)
	switch model {
	case "", "labs-google-fx-image":
		return "labs-google-fx"
	case "labs-google-fx-veo":
		return "labs-google-fx-video"
	case "gemini-image":
		return "gemini-2.0-flash-preview-image-generation"
	default:
		return model
	}
}

func openAIModelKind(model string) string {
	normalized := strings.ToLower(strings.TrimSpace(model))
	if strings.Contains(normalized, "video") || strings.Contains(normalized, "veo") || strings.Contains(normalized, "_t2v_") || strings.Contains(normalized, "_i2v_") || strings.Contains(normalized, "_r2v_") {
		return "video"
	}
	return "image"
}

func openAIModelSite(model string) string {
	normalized := strings.ToLower(strings.TrimSpace(model))
	if strings.Contains(normalized, "gemini") {
		return "gemini"
	}
	return "labsfx"
}

func buildOpenAIMediaContent(mediaKind, mediaURL string) string {
	if mediaKind == "video" {
		return fmt.Sprintf(`<video src="%s" controls playsinline></video>`, mediaURL)
	}
	return fmt.Sprintf("![Generated Image](%s)", mediaURL)
}

func writeSSEJSON(c *gin.Context, payload interface{}) {
	body, _ := json.Marshal(payload)
	_, _ = c.Writer.Write([]byte("data: "))
	_, _ = c.Writer.Write(body)
	_, _ = c.Writer.Write([]byte("\n\n"))
	c.Writer.Flush()
}
