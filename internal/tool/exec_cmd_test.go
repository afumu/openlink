package tool

import (
	"strings"
	"testing"

	"github.com/afumu/openlink/internal/types"
)

func TestExecCmdValidate(t *testing.T) {
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10}
	tool := NewExecCmdTool(cfg)

	if err := tool.Validate(map[string]interface{}{"command": "ls"}); err != nil {
		t.Errorf("expected valid: %v", err)
	}
	if err := tool.Validate(map[string]interface{}{}); err == nil {
		t.Error("expected error for missing command")
	}
	if err := tool.Validate(map[string]interface{}{"command": "sudo rm -rf /"}); err == nil {
		t.Error("expected error for dangerous command")
	}
}

func TestExecCmdExecute(t *testing.T) {
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10}
	tool := NewExecCmdTool(cfg)

	t.Run("runs echo", func(t *testing.T) {
		res := tool.Execute(testCtx(cfg, map[string]interface{}{"command": "echo hello"}))
		if res.Status != "success" {
			t.Fatalf("expected success: %s", res.Error)
		}
		if !strings.Contains(res.Output, "hello") {
			t.Errorf("expected 'hello' in output, got %q", res.Output)
		}
	})

	t.Run("cmd alias works", func(t *testing.T) {
		res := tool.Execute(testCtx(cfg, map[string]interface{}{"cmd": "echo hi"}))
		if res.Status != "success" {
			t.Fatalf("expected success: %s", res.Error)
		}
	})

	t.Run("failed command returns error status", func(t *testing.T) {
		res := tool.Execute(testCtx(cfg, map[string]interface{}{"command": "exit 1"}))
		if res.Status != "error" {
			t.Error("expected error status for non-zero exit")
		}
	})
}
