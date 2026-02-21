package tool

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/afumu/openlink/internal/types"
)

func TestListDirTool(t *testing.T) {
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10}
	os.WriteFile(filepath.Join(cfg.RootDir, "a.txt"), []byte(""), 0644)
	os.MkdirAll(filepath.Join(cfg.RootDir, "subdir"), 0755)
	tool := NewListDirTool(cfg)

	t.Run("lists files and dirs", func(t *testing.T) {
		res := tool.Execute(testCtx(cfg, map[string]interface{}{"path": "."}))
		if res.Status != "success" {
			t.Fatal(res.Error)
		}
		if !strings.Contains(res.Output, "a.txt") || !strings.Contains(res.Output, "subdir/") {
			t.Errorf("unexpected output: %q", res.Output)
		}
	})

	t.Run("path traversal blocked", func(t *testing.T) {
		res := tool.Execute(testCtx(cfg, map[string]interface{}{"path": "../outside"}))
		if res.Status != "error" {
			t.Error("expected error")
		}
	})

	t.Run("empty dir returns empty", func(t *testing.T) {
		empty := filepath.Join(cfg.RootDir, "empty")
		os.MkdirAll(empty, 0755)
		res := tool.Execute(testCtx(cfg, map[string]interface{}{"path": "empty"}))
		if res.Output != "empty" {
			t.Errorf("got %q", res.Output)
		}
	})
}

func TestQuestionTool(t *testing.T) {
	tool := NewQuestionTool()

	t.Run("returns question in output", func(t *testing.T) {
		res := tool.Execute(&Context{Args: map[string]interface{}{"question": "What is your name?"}})
		if res.Status != "success" || !strings.Contains(res.Output, "What is your name?") {
			t.Errorf("got %q", res.Output)
		}
	})

	t.Run("includes options when provided", func(t *testing.T) {
		res := tool.Execute(&Context{Args: map[string]interface{}{
			"question": "Pick one",
			"options":  []interface{}{"A", "B"},
		}})
		if !strings.Contains(res.Output, "A") || !strings.Contains(res.Output, "B") {
			t.Errorf("got %q", res.Output)
		}
	})

	t.Run("validate rejects missing question", func(t *testing.T) {
		if err := tool.Validate(map[string]interface{}{}); err == nil {
			t.Error("expected error")
		}
	})
}

func TestInvalidTool(t *testing.T) {
	tool := &InvalidTool{}
	res := tool.Execute(&Context{Args: map[string]interface{}{"tool": "foo_bar"}})
	if res.Status != "error" || !strings.Contains(res.Error, "foo_bar") {
		t.Errorf("got status=%s error=%q", res.Status, res.Error)
	}
}

func TestTodoWriteTool(t *testing.T) {
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10}
	tool := NewTodoWriteTool(cfg)

	t.Run("writes todos to file", func(t *testing.T) {
		todos := []interface{}{"task1", "task2"}
		res := tool.Execute(testCtx(cfg, map[string]interface{}{"todos": todos}))
		if res.Status != "success" {
			t.Fatalf("expected success: %s", res.Error)
		}
		if _, err := os.Stat(filepath.Join(cfg.RootDir, ".todos.json")); err != nil {
			t.Error("expected .todos.json to exist")
		}
	})

	t.Run("validate rejects missing todos", func(t *testing.T) {
		if err := tool.Validate(map[string]interface{}{}); err == nil {
			t.Error("expected error")
		}
	})
}

func TestSkillTool(t *testing.T) {
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10}

	t.Run("lists skills when no name given", func(t *testing.T) {
		tool := NewSkillTool(cfg)
		res := tool.Execute(testCtx(cfg, map[string]interface{}{}))
		if res.Status != "success" {
			t.Fatalf("expected success: %s", res.Error)
		}
	})

	t.Run("returns error for unknown skill", func(t *testing.T) {
		tool := NewSkillTool(cfg)
		res := tool.Execute(testCtx(cfg, map[string]interface{}{"skill": "nonexistent"}))
		if res.Status != "error" {
			t.Error("expected error for unknown skill")
		}
	})

	t.Run("loads existing skill", func(t *testing.T) {
		os.MkdirAll(filepath.Join(cfg.RootDir, ".skills"), 0755)
		os.WriteFile(filepath.Join(cfg.RootDir, ".skills", "mything.md"), []byte("skill content"), 0644)
		tool := NewSkillTool(cfg)
		res := tool.Execute(testCtx(cfg, map[string]interface{}{"skill": "mything"}))
		if res.Status != "success" || res.Output != "skill content" {
			t.Errorf("got status=%s output=%q", res.Status, res.Output)
		}
	})
}
