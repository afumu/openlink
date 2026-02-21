package tool

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/afumu/openlink/internal/types"
)

func testConfig(t *testing.T) *types.Config {
	t.Helper()
	return &types.Config{RootDir: t.TempDir(), Timeout: 10}
}

func testCtx(cfg *types.Config, args map[string]interface{}) *Context {
	return &Context{Args: args, Config: cfg}
}

func TestWriteReadFile(t *testing.T) {
	cfg := testConfig(t)

	t.Run("write then read", func(t *testing.T) {
		w := NewWriteFileTool(cfg)
		r := NewReadFileTool(cfg)

		res := w.Execute(testCtx(cfg, map[string]interface{}{"path": "hello.txt", "content": "world"}))
		if res.Status != "success" {
			t.Fatalf("write failed: %s", res.Error)
		}

		res = r.Execute(testCtx(cfg, map[string]interface{}{"path": "hello.txt"}))
		if res.Status != "success" {
			t.Fatalf("read failed: %s", res.Error)
		}
		if !strings.Contains(res.Output, "world") {
			t.Errorf("expected 'world' in output, got %q", res.Output)
		}
	})

	t.Run("write creates parent dirs", func(t *testing.T) {
		w := NewWriteFileTool(cfg)
		res := w.Execute(testCtx(cfg, map[string]interface{}{"path": "sub/dir/file.txt", "content": "hi"}))
		if res.Status != "success" {
			t.Fatalf("write failed: %s", res.Error)
		}
		if _, err := os.Stat(filepath.Join(cfg.RootDir, "sub/dir/file.txt")); err != nil {
			t.Error("file not created")
		}
	})

	t.Run("write append mode", func(t *testing.T) {
		w := NewWriteFileTool(cfg)
		w.Execute(testCtx(cfg, map[string]interface{}{"path": "append.txt", "content": "line1\n"}))
		w.Execute(testCtx(cfg, map[string]interface{}{"path": "append.txt", "content": "line2\n", "mode": "append"}))

		r := NewReadFileTool(cfg)
		res := r.Execute(testCtx(cfg, map[string]interface{}{"path": "append.txt"}))
		if !strings.Contains(res.Output, "line1") || !strings.Contains(res.Output, "line2") {
			t.Errorf("expected both lines, got %q", res.Output)
		}
	})

	t.Run("path traversal blocked", func(t *testing.T) {
		w := NewWriteFileTool(cfg)
		res := w.Execute(testCtx(cfg, map[string]interface{}{"path": "../outside.txt", "content": "x"}))
		if res.Status != "error" {
			t.Error("expected error for path traversal")
		}
	})
}

func TestGlobTool(t *testing.T) {
	cfg := testConfig(t)
	os.WriteFile(filepath.Join(cfg.RootDir, "a.go"), []byte(""), 0644)
	os.WriteFile(filepath.Join(cfg.RootDir, "b.go"), []byte(""), 0644)
	os.WriteFile(filepath.Join(cfg.RootDir, "c.txt"), []byte(""), 0644)

	g := NewGlobTool(cfg)

	t.Run("matches go files", func(t *testing.T) {
		res := g.Execute(testCtx(cfg, map[string]interface{}{"pattern": "*.go"}))
		if res.Status != "success" {
			t.Fatal(res.Error)
		}
		if !strings.Contains(res.Output, "a.go") || !strings.Contains(res.Output, "b.go") {
			t.Errorf("expected go files, got %q", res.Output)
		}
		if strings.Contains(res.Output, "c.txt") {
			t.Error("should not match txt file")
		}
	})

	t.Run("no match returns no files found", func(t *testing.T) {
		res := g.Execute(testCtx(cfg, map[string]interface{}{"pattern": "*.rs"}))
		if res.Output != "No files found" {
			t.Errorf("got %q", res.Output)
		}
	})
}

func TestGrepTool(t *testing.T) {
	cfg := testConfig(t)
	os.WriteFile(filepath.Join(cfg.RootDir, "main.go"), []byte("package main\nfunc main() {}\n"), 0644)

	g := NewGrepTool(cfg)

	t.Run("finds pattern", func(t *testing.T) {
		res := g.Execute(testCtx(cfg, map[string]interface{}{"pattern": "func main"}))
		if res.Status != "success" {
			t.Fatal(res.Error)
		}
		if !strings.Contains(res.Output, "func main") {
			t.Errorf("expected match, got %q", res.Output)
		}
	})

	t.Run("no match", func(t *testing.T) {
		res := g.Execute(testCtx(cfg, map[string]interface{}{"pattern": "notexist"}))
		if res.Output != "No matches found" {
			t.Errorf("got %q", res.Output)
		}
	})

	t.Run("include filter with path separator blocked", func(t *testing.T) {
		g2 := NewGrepTool(cfg)
		err := g2.Validate(map[string]interface{}{"pattern": "x", "include": "../*.go"})
		if err == nil {
			t.Error("expected error for include with path separator")
		}
	})
}

func TestEditTool(t *testing.T) {
	cfg := testConfig(t)

	t.Run("replaces string in file", func(t *testing.T) {
		path := filepath.Join(cfg.RootDir, "edit.txt")
		os.WriteFile(path, []byte("hello world"), 0644)

		e := NewEditTool(cfg)
		res := e.Execute(testCtx(cfg, map[string]interface{}{
			"path": "edit.txt", "old_string": "world", "new_string": "go",
		}))
		if res.Status != "success" {
			t.Fatalf("edit failed: %s", res.Error)
		}
		got, _ := os.ReadFile(path)
		if string(got) != "hello go" {
			t.Errorf("got %q", got)
		}
	})

	t.Run("old_string not found returns error", func(t *testing.T) {
		os.WriteFile(filepath.Join(cfg.RootDir, "nope.txt"), []byte("abc"), 0644)
		e := NewEditTool(cfg)
		res := e.Execute(testCtx(cfg, map[string]interface{}{
			"path": "nope.txt", "old_string": "xyz", "new_string": "q",
		}))
		if res.Status != "error" {
			t.Error("expected error")
		}
	})
}
