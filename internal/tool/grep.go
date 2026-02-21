package tool

import (
	"bufio"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/afumu/openlink/internal/security"
	"github.com/afumu/openlink/internal/types"
)

type GrepTool struct {
	config *types.Config
}

func NewGrepTool(config *types.Config) *GrepTool {
	return &GrepTool{config: config}
}

func (t *GrepTool) Name() string        { return "grep" }
func (t *GrepTool) Description() string { return "Search file contents using regex" }
func (t *GrepTool) Parameters() interface{} {
	return map[string]string{
		"pattern": "string (required) - regex pattern to search",
		"path":    "string (optional) - directory to search (default: root)",
		"include": "string (optional) - file glob filter, e.g. *.go",
	}
}

func (t *GrepTool) Validate(args map[string]interface{}) error {
	if p, ok := args["pattern"].(string); !ok || p == "" {
		return errors.New("pattern is required")
	}
	return nil
}

func (t *GrepTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	pattern, _ := ctx.Args["pattern"].(string)
	searchPath, _ := ctx.Args["path"].(string)
	include, _ := ctx.Args["include"].(string)
	if searchPath == "" {
		searchPath = "."
	}

	safePath, err := security.SafePath(ctx.Config.RootDir, searchPath)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	var output string
	if rgPath, err := exec.LookPath("rg"); err == nil {
		output = grepWithRg(rgPath, pattern, safePath, include)
	} else {
		output, err = grepNative(pattern, safePath, include)
		if err != nil {
			result.Status = "error"
			result.Error = err.Error()
			return result
		}
	}

	result.Status = "success"
	result.Output = output
	result.EndTime = time.Now()
	return result
}

func grepWithRg(rgPath, pattern, searchPath, include string) string {
	args := []string{"-n", "--no-heading"}
	if include != "" {
		args = append(args, "--glob", include)
	}
	args = append(args, "--", pattern, searchPath)
	cmd := exec.Command(rgPath, args...)
	out, _ := cmd.Output()
	lines := strings.Split(strings.ReplaceAll(string(out), "\r\n", "\n"), "\n")
	return formatGrepLines(lines, 100)
}

func grepNative(pattern, searchPath, include string) (string, error) {
	re, err := regexp.Compile(pattern)
	if err != nil {
		return "", fmt.Errorf("invalid pattern: %w", err)
	}

	type match struct {
		line  string
		mtime time.Time
	}
	var matches []match

	filepath.WalkDir(searchPath, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if include != "" {
			if ok, _ := filepath.Match(include, d.Name()); !ok {
				return nil
			}
		}
		info, _ := d.Info()
		mtime := info.ModTime()

		f, err := os.Open(p)
		if err != nil {
			return nil
		}
		defer f.Close()

		lineNum := 0
		scanner := bufio.NewScanner(f)
		for scanner.Scan() {
			lineNum++
			text := scanner.Text()
			if re.MatchString(text) {
				matches = append(matches, match{
					line:  fmt.Sprintf("%s:%d:%s", filepath.ToSlash(p), lineNum, text),
					mtime: mtime,
				})
			}
		}
		return nil
	})

	sort.Slice(matches, func(i, j int) bool {
		return matches[i].mtime.After(matches[j].mtime)
	})

	lines := make([]string, len(matches))
	for i, m := range matches {
		lines[i] = m.line
	}
	return formatGrepLines(lines, 100), nil
}

func formatGrepLines(lines []string, limit int) string {
	var out []string
	count := 0
	for _, l := range lines {
		if l == "" {
			continue
		}
		out = append(out, l)
		count++
		if count >= limit {
			out = append(out, fmt.Sprintf("(结果已截断，仅显示前 %d 条)", limit))
			break
		}
	}
	if len(out) == 0 {
		return "No matches found"
	}
	return strings.Join(out, "\n")
}
