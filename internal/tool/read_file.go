package tool

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/afumu/openlink/internal/security"
	"github.com/afumu/openlink/internal/types"
)

type ReadFileTool struct {
	config *types.Config
}

func NewReadFileTool(config *types.Config) *ReadFileTool {
	return &ReadFileTool{config: config}
}

func (t *ReadFileTool) Name() string {
	return "read_file"
}

func (t *ReadFileTool) Description() string {
	return "Read file contents"
}

func (t *ReadFileTool) Parameters() interface{} {
	return map[string]string{
		"path":   "string (required) - file path to read",
		"offset": "number (optional) - start line number, 1-based (default: 1)",
		"limit":  "number (optional) - max lines to read (default: 2000)",
	}
}

func (t *ReadFileTool) Validate(args map[string]interface{}) error {
	path, ok := args["path"].(string)
	if !ok || path == "" {
		return errors.New("path is required")
	}
	return nil
}

func (t *ReadFileTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	path, _ := ctx.Args["path"].(string)

	offset := 1
	limit := MaxLines
	if v, ok := ctx.Args["offset"].(float64); ok && v >= 1 {
		offset = int(v)
	}
	if v, ok := ctx.Args["limit"].(float64); ok && v >= 1 {
		limit = int(v)
		if limit > MaxLines {
			limit = MaxLines
		}
	}

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

	f, err := os.Open(safePath)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}
	defer f.Close()

	var lines []string
	totalLines := 0
	byteCount := 0
	truncated := false

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		totalLines++
		if totalLines < offset {
			continue
		}
		if len(lines) >= limit {
			truncated = true
			// count remaining lines
			for scanner.Scan() {
				totalLines++
			}
			break
		}
		line := scanner.Text()
		byteCount += len(line) + 1
		if byteCount > MaxBytes {
			truncated = true
			for scanner.Scan() {
				totalLines++
			}
			break
		}
		lines = append(lines, line)
	}

	if err := scanner.Err(); err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	output := strings.Join(lines, "\n")
	if output == "" {
		output = "empty"
	}
	if truncated {
		nextOffset := offset + len(lines)
		output += fmt.Sprintf("\n[truncated, %d total lines, use offset=%d to continue]", totalLines, nextOffset)
	}

	result.Status = "success"
	result.Output = output
	result.EndTime = time.Now()
	return result
}
