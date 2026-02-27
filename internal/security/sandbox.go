package security

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// SafePath joins rootDir+targetPath and validates the result stays within rootDir.
// targetPath must be relative.
func SafePath(rootDir, targetPath string) (string, error) {
	absRoot, err := filepath.EvalSymlinks(rootDir)
	if err != nil {
		absRoot, err = filepath.Abs(rootDir)
		if err != nil {
			return "", err
		}
	}
	joined := filepath.Join(absRoot, targetPath)
	// EvalSymlinks 解析符号链接；文件不存在时（新建场景）fallback 到 Abs
	absTarget, err := filepath.EvalSymlinks(joined)
	if err != nil {
		absTarget, err = filepath.Abs(joined)
		if err != nil {
			return "", err
		}
	}
	if !strings.HasPrefix(absTarget, absRoot+string(filepath.Separator)) && absTarget != absRoot {
		return "", errors.New("path outside sandbox")
	}
	return absTarget, nil
}

// SafeAbsPath validates an already-absolute (or ~-prefixed) path against one or more allowed roots.
func SafeAbsPath(targetPath string, allowedRoots ...string) (string, error) {
	if strings.HasPrefix(targetPath, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		targetPath = filepath.Join(home, targetPath[2:])
	}
	if !filepath.IsAbs(targetPath) {
		return "", errors.New("not an absolute path")
	}
	absTarget, err := filepath.EvalSymlinks(targetPath)
	if err != nil {
		absTarget, err = filepath.Abs(targetPath)
		if err != nil {
			return "", err
		}
	}
	for _, rootDir := range allowedRoots {
		absRoot, err := filepath.EvalSymlinks(rootDir)
		if err != nil {
			absRoot, err = filepath.Abs(rootDir)
			if err != nil {
				continue
			}
		}
		if strings.HasPrefix(absTarget, absRoot+string(filepath.Separator)) || absTarget == absRoot {
			return absTarget, nil
		}
	}
	return "", errors.New("path outside sandbox")
}

// dangerousPatterns 需要子串匹配的多词危险模式（含空格或特殊字符，不会误匹配普通路径）
var dangerousPatterns = []string{
	"rm -rf", "rm -fr", "> /dev/", "chmod 777", "kill -9",
}

// dangerousCommands 需要单词边界匹配的单词命令（避免误匹配路径中的子串）
// 注意：curl/wget 属于正常网络工具，不在拦截范围内
var dangerousCommands = []string{
	"mkfs", "format", "nc", "netcat",
	"sudo", "reboot", "shutdown",
}

// isCmdSeparator 判断字符是否为 shell 命令分隔符或空白
func isCmdSeparator(b byte) bool {
	switch b {
	case ' ', '\t', '\n', ';', '|', '&', '(', ')', '`', '\'', '"', '<', '>':
		return true
	}
	return false
}

func IsDangerousCommand(cmd string) bool {
	lower := strings.ToLower(cmd)

	// 多词模式：直接子串匹配
	for _, p := range dangerousPatterns {
		if strings.Contains(lower, p) {
			return true
		}
	}

	// 单词命令：要求前后是分隔符或字符串边界
	for _, word := range dangerousCommands {
		idx := 0
		for {
			pos := strings.Index(lower[idx:], word)
			if pos < 0 {
				break
			}
			abs := idx + pos
			before := abs == 0 || isCmdSeparator(lower[abs-1])
			after := abs+len(word) >= len(lower) || isCmdSeparator(lower[abs+len(word)])
			if before && after {
				return true
			}
			idx = abs + 1
		}
	}
	return false
}
