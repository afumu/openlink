package tool

import (
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/afumu/openlink/internal/security"
	"github.com/afumu/openlink/internal/types"
)

type GlobTool struct {
	config *types.Config
}

func NewGlobTool(config *types.Config) *GlobTool {
	return &GlobTool{config: config}
}

func (t *GlobTool) Name() string        { return "glob" }
func (t *GlobTool) Description() string { return "Find files matching a glob pattern" }
func (t *GlobTool) Parameters() interface{} {
	return map[string]string{
		"pattern": "string (required) - glob pattern, e.g. **/*.go or *.ts",
		"path":    "string (optional) - directory to search in (default: root)",
	}
}

func (t *GlobTool) Validate(args map[string]interface{}) error {
	if p, ok := args["pattern"].(string); !ok || p == "" {
		return errors.New("pattern is required")
	}
	return nil
}

func (t *GlobTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	pattern, _ := ctx.Args["pattern"].(string)
	searchPath, _ := ctx.Args["path"].(string)
	if searchPath == "" {
		searchPath = "."
	}

	safePath, err := security.SafePath(ctx.Config.RootDir, searchPath)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	type fileEntry struct {
		path  string
		mtime time.Time
	}
	var files []fileEntry

	basePat := filepath.Base(pattern)
	isRecursive := strings.Contains(pattern, "**")

	filepath.WalkDir(safePath, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		name := d.Name()
		var matched bool
		if isRecursive {
			matched, _ = filepath.Match(basePat, name)
		} else {
			rel, _ := filepath.Rel(safePath, p)
			matched, _ = filepath.Match(pattern, rel)
			if !matched {
				matched, _ = filepath.Match(basePat, name)
			}
		}
		if matched {
			info, _ := d.Info()
			files = append(files, fileEntry{
				path:  filepath.ToSlash(p),
				mtime: info.ModTime(),
			})
		}
		return nil
	})

	sort.Slice(files, func(i, j int) bool {
		return files[i].mtime.After(files[j].mtime)
	})

	const limit = 100
	truncated := len(files) > limit
	if truncated {
		files = files[:limit]
	}

	var lines []string
	for _, f := range files {
		lines = append(lines, f.path)
	}
	if truncated {
		lines = append(lines, fmt.Sprintf("(结果已截断，仅显示前 %d 条)", limit))
	}

	result.Status = "success"
	if len(lines) == 0 {
		result.Output = "No files found"
	} else {
		result.Output = strings.Join(lines, "\n")
	}
	result.EndTime = time.Now()
	return result
}
