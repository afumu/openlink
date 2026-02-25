package tool

import (
	"os"
	"path/filepath"
	"time"

	"github.com/afumu/openlink/internal/security"
	"github.com/afumu/openlink/internal/types"
)

type Tool interface {
	Name() string
	Description() string
	Parameters() interface{}
	Validate(args map[string]interface{}) error
	Execute(ctx *Context) *Result
}

type Context struct {
	Args   map[string]interface{}
	Config *types.Config
}

type Result struct {
	Status     string
	Output     string
	Error      string
	StopStream bool
	StartTime  time.Time
	EndTime    time.Time
}

type ToolInfo struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	Parameters  interface{} `json:"parameters,omitempty"`
}

// resolveAbsPath validates an absolute path against RootDir and common allowed roots (~/.claude, ~/.openlink, ~/.agent).
func resolveAbsPath(path, rootDir string) (string, error) {
	home, _ := os.UserHomeDir()
	roots := []string{
		rootDir,
		filepath.Join(home, ".claude"),
		filepath.Join(home, ".openlink"),
		filepath.Join(home, ".agent"),
	}
	return security.SafeAbsPath(path, roots...)
}
