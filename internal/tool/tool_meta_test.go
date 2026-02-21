package tool

import (
	"strings"
	"testing"

	"github.com/afumu/openlink/internal/types"
)

// Tests for Name/Description/Parameters/Validate methods that have 0% coverage

func TestToolMeta(t *testing.T) {
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10}

	tools := []interface {
		Name() string
		Description() string
		Parameters() interface{}
	}{
		NewEditTool(cfg),
		NewExecCmdTool(cfg),
		NewGlobTool(cfg),
		NewGrepTool(cfg),
		NewListDirTool(cfg),
		NewQuestionTool(),
		NewReadFileTool(cfg),
		NewWriteFileTool(cfg),
		NewSkillTool(cfg),
		NewTodoWriteTool(cfg),
		NewWebFetchTool(),
	}

	for _, tool := range tools {
		if tool.Name() == "" {
			t.Errorf("%T: Name() returned empty string", tool)
		}
		if tool.Description() == "" {
			t.Errorf("%T: Description() returned empty string", tool)
		}
		if tool.Parameters() == nil {
			t.Errorf("%T: Parameters() returned nil", tool)
		}
	}
}

func TestValidateMethods(t *testing.T) {
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10}

	t.Run("EditTool validate missing path", func(t *testing.T) {
		if err := NewEditTool(cfg).Validate(map[string]interface{}{}); err == nil {
			t.Error("expected error")
		}
	})

	t.Run("GlobTool validate missing pattern", func(t *testing.T) {
		if err := NewGlobTool(cfg).Validate(map[string]interface{}{}); err == nil {
			t.Error("expected error")
		}
	})

	t.Run("ReadFileTool validate missing path", func(t *testing.T) {
		if err := NewReadFileTool(cfg).Validate(map[string]interface{}{}); err == nil {
			t.Error("expected error")
		}
	})

	t.Run("WriteFileTool validate missing path", func(t *testing.T) {
		if err := NewWriteFileTool(cfg).Validate(map[string]interface{}{}); err == nil {
			t.Error("expected error")
		}
	})

	t.Run("SkillTool validate always passes", func(t *testing.T) {
		if err := NewSkillTool(cfg).Validate(map[string]interface{}{}); err != nil {
			t.Errorf("unexpected error: %v", err)
		}
	})
}

func TestReadFileOffsetLimit(t *testing.T) {
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10}
	w := NewWriteFileTool(cfg)
	r := NewReadFileTool(cfg)

	// Write 10 lines
	var sb strings.Builder
	for i := 1; i <= 10; i++ {
		sb.WriteString("line\n")
	}
	w.Execute(testCtx(cfg, map[string]interface{}{"path": "lines.txt", "content": sb.String()}))

	t.Run("offset skips lines", func(t *testing.T) {
		res := r.Execute(testCtx(cfg, map[string]interface{}{"path": "lines.txt", "offset": float64(5)}))
		if res.Status != "success" {
			t.Fatal(res.Error)
		}
	})

	t.Run("limit restricts lines", func(t *testing.T) {
		res := r.Execute(testCtx(cfg, map[string]interface{}{"path": "lines.txt", "limit": float64(2)}))
		if res.Status != "success" {
			t.Fatal(res.Error)
		}
		if !strings.Contains(res.Output, "truncated") {
			t.Errorf("expected truncation notice, got %q", res.Output)
		}
	})

	t.Run("nonexistent file returns error", func(t *testing.T) {
		res := r.Execute(testCtx(cfg, map[string]interface{}{"path": "nope.txt"}))
		if res.Status != "error" {
			t.Error("expected error for missing file")
		}
	})
}

func TestExecCmdGetShell(t *testing.T) {
	shell, flag := getShell()
	if shell == "" || flag == "" {
		t.Error("getShell returned empty values")
	}
}

func TestGrepWithInclude(t *testing.T) {
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10}
	w := NewWriteFileTool(cfg)
	w.Execute(testCtx(cfg, map[string]interface{}{"path": "foo.go", "content": "package main\n"}))
	w.Execute(testCtx(cfg, map[string]interface{}{"path": "foo.txt", "content": "package main\n"}))

	g := NewGrepTool(cfg)
	res := g.Execute(testCtx(cfg, map[string]interface{}{
		"pattern": "package",
		"include": "*.go",
	}))
	if res.Status != "success" {
		t.Fatal(res.Error)
	}
	if !strings.Contains(res.Output, "foo.go") {
		t.Errorf("expected foo.go in output, got %q", res.Output)
	}
}
