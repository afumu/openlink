package tool

import (
	"errors"
	"os"
	"time"

	"github.com/afumu/openlink/internal/security"
	"github.com/afumu/openlink/internal/types"
)

type WriteFileTool struct {
	config *types.Config
}

func NewWriteFileTool(config *types.Config) *WriteFileTool {
	return &WriteFileTool{config: config}
}

func (t *WriteFileTool) Name() string {
	return "write_file"
}

func (t *WriteFileTool) Description() string {
	return "Write content to file"
}

func (t *WriteFileTool) Parameters() interface{} {
	return map[string]string{
		"path":    "string (required) - file path to write",
		"content": "string (required) - content to write",
		"mode":    "string (optional) - 'append' or 'overwrite' (default)",
	}
}

func (t *WriteFileTool) Validate(args map[string]interface{}) error {
	path, ok := args["path"].(string)
	if !ok || path == "" {
		return errors.New("path is required")
	}
	return nil
}

func (t *WriteFileTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	path, _ := ctx.Args["path"].(string)
	content, _ := ctx.Args["content"].(string)
	mode, _ := ctx.Args["mode"].(string)

	safePath, err := security.SafePath(ctx.Config.RootDir, path)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	if mode == "append" {
		f, err := os.OpenFile(safePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
		if err != nil {
			result.Status = "error"
			result.Error = err.Error()
			return result
		}
		defer f.Close()
		if _, err := f.WriteString(content); err != nil {
			result.Status = "error"
			result.Error = err.Error()
			return result
		}
	} else {
		if err := os.WriteFile(safePath, []byte(content), 0644); err != nil {
			result.Status = "error"
			result.Error = err.Error()
			return result
		}
	}

	result.Status = "success"
	result.Output = "写入成功"
	result.EndTime = time.Now()
	return result
}
