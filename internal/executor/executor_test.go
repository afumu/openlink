package executor

import (
	"context"
	"testing"

	"github.com/afumu/openlink/internal/types"
)

func testConfig(t *testing.T) *types.Config {
	t.Helper()
	return &types.Config{RootDir: t.TempDir(), Timeout: 10}
}

func TestExecutor(t *testing.T) {
	t.Run("unknown tool returns error", func(t *testing.T) {
		e := New(testConfig(t))
		resp := e.Execute(context.Background(), &types.ToolRequest{Name: "no_such_tool"})
		if resp.Status != "error" {
			t.Errorf("expected error, got %s", resp.Status)
		}
	})

	t.Run("validation failure returns error", func(t *testing.T) {
		e := New(testConfig(t))
		resp := e.Execute(context.Background(), &types.ToolRequest{
			Name: "exec_cmd",
			Args: map[string]interface{}{}, // missing command
		})
		if resp.Status != "error" {
			t.Errorf("expected error, got %s", resp.Status)
		}
	})

	t.Run("exec_cmd runs successfully", func(t *testing.T) {
		e := New(testConfig(t))
		resp := e.Execute(context.Background(), &types.ToolRequest{
			Name: "exec_cmd",
			Args: map[string]interface{}{"command": "echo hello"},
		})
		if resp.Status != "success" {
			t.Errorf("expected success, got %s: %s", resp.Status, resp.Error)
		}
	})

	t.Run("list tools returns all registered tools", func(t *testing.T) {
		e := New(testConfig(t))
		tools := e.ListTools()
		if len(tools) == 0 {
			t.Error("expected tools to be registered")
		}
	})
}
