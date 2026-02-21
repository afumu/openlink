package tool

import (
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

type WebFetchTool struct{}

func NewWebFetchTool() *WebFetchTool { return &WebFetchTool{} }

func (t *WebFetchTool) Name() string        { return "web_fetch" }
func (t *WebFetchTool) Description() string { return "Fetch web page content via HTTP" }
func (t *WebFetchTool) Parameters() interface{} {
	return map[string]string{
		"url":    "string (required) - http/https URL to fetch",
		"format": "string (optional) - 'text' (default, strips HTML) or 'html'",
	}
}

func (t *WebFetchTool) Validate(args map[string]interface{}) error {
	url, ok := args["url"].(string)
	if !ok || url == "" {
		return fmt.Errorf("url is required")
	}
	if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
		return fmt.Errorf("only http/https URLs are supported")
	}
	return nil
}

var (
	htmlTagRe    = regexp.MustCompile(`<[^>]+>`)
	multiSpaceRe = regexp.MustCompile(`[ \t]{2,}`)
	multiNewline = regexp.MustCompile(`\n{3,}`)
)

func stripHTML(s string) string {
	s = htmlTagRe.ReplaceAllString(s, " ")
	s = multiSpaceRe.ReplaceAllString(s, " ")
	s = multiNewline.ReplaceAllString(s, "\n\n")
	return strings.TrimSpace(s)
}

func (t *WebFetchTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	url, _ := ctx.Args["url"].(string)
	format, _ := ctx.Args["format"].(string)

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1*1024*1024))
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	content := string(body)
	if format != "html" {
		content = stripHTML(content)
	}

	output, _ := Truncate(content)
	result.Status = "success"
	result.Output = output
	result.EndTime = time.Now()
	return result
}
