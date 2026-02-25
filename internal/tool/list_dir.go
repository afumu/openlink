package tool

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/afumu/openlink/internal/security"
	"github.com/afumu/openlink/internal/types"
)

type ListDirTool struct {
	config *types.Config
}

func NewListDirTool(config *types.Config) *ListDirTool {
	return &ListDirTool{config: config}
}

func (t *ListDirTool) Name() string {
	return "list_dir"
}

func (t *ListDirTool) Description() string {
	return "List directory contents"
}

func (t *ListDirTool) Parameters() interface{} {
	return map[string]string{
		"path": "string (required) - directory path to list",
	}
}

func (t *ListDirTool) Validate(args map[string]interface{}) error {
	path, ok := args["path"].(string)
	if !ok || path == "" {
		return errors.New("path is required")
	}
	return nil
}

func (t *ListDirTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	path, _ := ctx.Args["path"].(string)

	var safePath string
	var err error
	if filepath.IsAbs(path) {
		safePath, err = resolveAbsPath(path, ctx.Config.RootDir)
	} else {
		safePath, err = security.SafePath(ctx.Config.RootDir, path)
	}
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	entries, err := os.ReadDir(safePath)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	var names []string
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() {
			name += "/"
		}
		names = append(names, name)
	}

	result.Status = "success"
	result.Output = strings.Join(names, "\n")
	if result.Output == "" {
		result.Output = "empty"
	}
	result.EndTime = time.Now()
	return result
}
