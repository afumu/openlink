package tool

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/afumu/openlink/internal/types"
)

type TodoWriteTool struct {
	config *types.Config
}

func NewTodoWriteTool(config *types.Config) *TodoWriteTool {
	return &TodoWriteTool{config: config}
}

func (t *TodoWriteTool) Name() string        { return "todo_write" }
func (t *TodoWriteTool) Description() string { return "Write task list to .todos.json" }
func (t *TodoWriteTool) Parameters() interface{} {
	return map[string]string{
		"todos": "array (required) - full list of todo items to save",
	}
}

func (t *TodoWriteTool) Validate(args map[string]interface{}) error {
	if _, ok := args["todos"]; !ok {
		return errors.New("todos is required")
	}
	return nil
}

func (t *TodoWriteTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	todos := ctx.Args["todos"]
	data, err := json.MarshalIndent(todos, "", "  ")
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}
	p := filepath.Join(ctx.Config.RootDir, ".todos.json")
	if err := os.WriteFile(p, data, 0644); err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}
	items, _ := todos.([]interface{})
	result.Status = "success"
	result.Output = fmt.Sprintf("已保存 %d 个任务", len(items))
	result.EndTime = time.Now()
	return result
}
