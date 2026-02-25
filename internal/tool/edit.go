package tool

import (
	"bufio"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/afumu/openlink/internal/security"
	"github.com/afumu/openlink/internal/types"
)

type EditTool struct {
	config *types.Config
}

func NewEditTool(config *types.Config) *EditTool {
	return &EditTool{config: config}
}

func (t *EditTool) Name() string        { return "edit" }
func (t *EditTool) Description() string { return "Replace a string in a file (exact match)" }
func (t *EditTool) Parameters() interface{} {
	return map[string]string{
		"path":        "string (required) - file path",
		"old_string":  "string (required) - text to replace",
		"new_string":  "string (required) - replacement text",
		"replace_all": "bool (optional) - replace all occurrences (default false)",
	}
}

func (t *EditTool) Validate(args map[string]interface{}) error {
	if p, ok := args["path"].(string); !ok || p == "" {
		return errors.New("path is required")
	}
	if _, ok := args["old_string"].(string); !ok {
		return errors.New("old_string is required")
	}
	if _, ok := args["new_string"].(string); !ok {
		return errors.New("new_string is required")
	}
	return nil
}

func (t *EditTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	path, _ := ctx.Args["path"].(string)
	oldStr, _ := ctx.Args["old_string"].(string)
	newStr, _ := ctx.Args["new_string"].(string)
	replaceAll, _ := ctx.Args["replace_all"].(bool)

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

	content, err := os.ReadFile(safePath)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	log.Printf("[edit] old_string: %q\n", oldStr)
	log.Printf("[edit] new_string: %q\n", newStr)
	replaced, err := replaceInContent(string(content), oldStr, newStr, replaceAll)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	if err := os.WriteFile(safePath, []byte(replaced), 0644); err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	result.Status = "success"
	result.Output = fmt.Sprintf("已替换 '%s' → '%s'", oldStr, newStr)
	result.EndTime = time.Now()
	return result
}

func replaceInContent(content, oldStr, newStr string, replaceAll bool) (string, error) {
	if strings.Contains(content, oldStr) {
		if replaceAll {
			return strings.ReplaceAll(content, oldStr, newStr), nil
		}
		return strings.Replace(content, oldStr, newStr, 1), nil
	}

	normalContent := strings.ReplaceAll(content, "\r\n", "\n")
	normalOld := strings.ReplaceAll(oldStr, "\r\n", "\n")
	if strings.Contains(normalContent, normalOld) {
		normalNew := strings.ReplaceAll(newStr, "\r\n", "\n")
		var result string
		if replaceAll {
			result = strings.ReplaceAll(normalContent, normalOld, normalNew)
		} else {
			result = strings.Replace(normalContent, normalOld, normalNew, 1)
		}
		if strings.Contains(content, "\r\n") {
			result = strings.ReplaceAll(result, "\n", "\r\n")
		}
		return result, nil
	}

	result, ok := lineTrimReplace(content, oldStr, newStr, replaceAll)
	if ok {
		return result, nil
	}

	result, ok = indentFlexibleReplace(content, oldStr, newStr, replaceAll)
	if ok {
		return result, nil
	}

	return "", fmt.Errorf("old_string not found in file")
}

func lineTrimReplace(content, oldStr, newStr string, replaceAll bool) (string, bool) {
	contentLines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	searchLines := strings.Split(strings.ReplaceAll(oldStr, "\r\n", "\n"), "\n")
	replaceLines := strings.Split(strings.ReplaceAll(newStr, "\r\n", "\n"), "\n")

	if len(searchLines) == 0 {
		return "", false
	}

	replaced := false
	var result []string
	i := 0
	for i < len(contentLines) {
		if !replaceAll && replaced {
			result = append(result, contentLines[i])
			i++
			continue
		}
		if i+len(searchLines) <= len(contentLines) {
			match := true
			for j, sl := range searchLines {
				if strings.TrimSpace(contentLines[i+j]) != strings.TrimSpace(sl) {
					match = false
					break
				}
			}
			if match {
				indent := leadingWhitespace(contentLines[i])
				for _, rl := range replaceLines {
					if rl == "" {
						result = append(result, "")
					} else {
						result = append(result, indent+strings.TrimLeft(rl, " \t"))
					}
				}
				i += len(searchLines)
				replaced = true
				continue
			}
		}
		result = append(result, contentLines[i])
		i++
	}

	if !replaced {
		return "", false
	}

	out := strings.Join(result, "\n")
	if strings.Contains(content, "\r\n") {
		out = strings.ReplaceAll(out, "\n", "\r\n")
	}
	return out, true
}

func leadingWhitespace(s string) string {
	scanner := bufio.NewScanner(strings.NewReader(s))
	scanner.Scan()
	line := scanner.Text()
	return line[:len(line)-len(strings.TrimLeft(line, " \t"))]
}

// indentFlexibleReplace strips common indentation before comparing lines.
func indentFlexibleReplace(content, oldStr, newStr string, replaceAll bool) (string, bool) {
	normalize := func(s string) string {
		return strings.ReplaceAll(s, "\r\n", "\n")
	}
	contentLines := strings.Split(normalize(content), "\n")
	searchLines := strings.Split(normalize(oldStr), "\n")
	replaceLines := strings.Split(normalize(newStr), "\n")

	if len(searchLines) == 0 {
		return "", false
	}

	minIndent := func(lines []string) int {
		min := -1
		for _, l := range lines {
			if strings.TrimSpace(l) == "" {
				continue
			}
			n := len(l) - len(strings.TrimLeft(l, " \t"))
			if min < 0 || n < min {
				min = n
			}
		}
		if min < 0 {
			return 0
		}
		return min
	}

	searchIndent := minIndent(searchLines)
	stripIndent := func(lines []string, n int) []string {
		out := make([]string, len(lines))
		for i, l := range lines {
			if len(l) >= n {
				out[i] = l[n:]
			} else {
				out[i] = strings.TrimLeft(l, " \t")
			}
		}
		return out
	}
	strippedSearch := stripIndent(searchLines, searchIndent)

	replaced := false
	var result []string
	i := 0
	for i < len(contentLines) {
		if !replaceAll && replaced {
			result = append(result, contentLines[i])
			i++
			continue
		}
		if i+len(searchLines) <= len(contentLines) {
			block := contentLines[i : i+len(searchLines)]
			blockIndent := minIndent(block)
			strippedBlock := stripIndent(block, blockIndent)
			match := true
			for j := range strippedSearch {
				if strippedBlock[j] != strippedSearch[j] {
					match = false
					break
				}
			}
			if match {
				indent := strings.Repeat(" ", blockIndent)
				replaceIndent := minIndent(replaceLines)
				for _, rl := range replaceLines {
					if strings.TrimSpace(rl) == "" {
						result = append(result, "")
					} else {
						stripped := rl
						if len(rl) >= replaceIndent {
							stripped = rl[replaceIndent:]
						}
						result = append(result, indent+stripped)
					}
				}
				i += len(searchLines)
				replaced = true
				continue
			}
		}
		result = append(result, contentLines[i])
		i++
	}

	if !replaced {
		return "", false
	}

	out := strings.Join(result, "\n")
	if strings.Contains(content, "\r\n") {
		out = strings.ReplaceAll(out, "\n", "\r\n")
	}
	return out, true
}
