package security

import (
	"errors"
	"path/filepath"
	"strings"
)

func SafePath(rootDir, targetPath string) (string, error) {
	absRoot, err := filepath.Abs(rootDir)
	if err != nil {
		return "", err
	}
	joined := filepath.Join(rootDir, targetPath)
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

var DangerousCommands = []string{
	"rm -rf", "rm -fr", "mkfs", "dd", "format",
	"> /dev/", "curl", "wget", "nc", "netcat",
	"sudo", "chmod 777", "kill -9", "reboot", "shutdown",
}

func IsDangerousCommand(cmd string) bool {
	lower := strings.ToLower(cmd)
	for _, dangerous := range DangerousCommands {
		if strings.Contains(lower, dangerous) {
			return true
		}
	}
	return false
}
