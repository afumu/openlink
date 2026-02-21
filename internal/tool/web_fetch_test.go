package tool

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWebFetchValidate(t *testing.T) {
	tool := NewWebFetchTool()

	if err := tool.Validate(map[string]interface{}{}); err == nil {
		t.Error("expected error for missing url")
	}
	if err := tool.Validate(map[string]interface{}{"url": "ftp://x.com"}); err == nil {
		t.Error("expected error for non-http scheme")
	}
}

func TestWebFetchSSRFBlocked(t *testing.T) {
	tool := NewWebFetchTool()

	blocked := []string{
		"http://127.0.0.1/",
		"http://localhost/",
		"http://169.254.169.254/latest/meta-data/",
		"http://192.168.1.1/",
	}
	for _, url := range blocked {
		if err := tool.Validate(map[string]interface{}{"url": url}); err == nil {
			t.Errorf("expected SSRF block for %s", url)
		}
	}
}

func TestWebFetchExecute(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("<html><body>hello world</body></html>"))
	}))
	defer srv.Close()

	tool := NewWebFetchTool()
	res := tool.Execute(&Context{Args: map[string]interface{}{"url": srv.URL}})
	if res.Status != "success" {
		t.Fatalf("expected success: %s", res.Error)
	}
	if !strings.Contains(res.Output, "hello world") {
		t.Errorf("expected content in output, got %q", res.Output)
	}
}
