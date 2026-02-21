package tool

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const MaxLines = 2000
const MaxBytes = 50 * 1024

// Truncate 检查输出是否超限，超限则写入临时文件并返回截断提示
func Truncate(output string) (string, bool) {
	normalized := strings.ReplaceAll(output, "\r\n", "\n")
	lines := strings.Split(normalized, "\n")

	if len(lines) <= MaxLines && len(normalized) <= MaxBytes {
		return output, false
	}

	end := MaxLines
	if end > len(lines) {
		end = len(lines)
	}
	preview := strings.Join(lines[:end], "\n")
	if len(preview) > MaxBytes {
		preview = preview[:MaxBytes]
	}

	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".openlink", "tool-output")
	os.MkdirAll(dir, 0755)
	id := fmt.Sprintf("%d", time.Now().UnixNano())
	fullPath := filepath.Join(dir, id)
	os.WriteFile(fullPath, []byte(output), 0644)

	hint := fmt.Sprintf(
		"\n\n...输出已截断（共 %d 行），完整内容保存至:\n%s\n使用 read_file 工具加 offset 参数分段读取",
		len(lines), fullPath,
	)
	return preview + hint, true
}
