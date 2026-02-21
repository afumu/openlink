package tool

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"time"

	"github.com/afumu/openlink/internal/security"
	"github.com/afumu/openlink/internal/types"
)

type ExecCmdTool struct {
	config *types.Config
}

func NewExecCmdTool(config *types.Config) *ExecCmdTool {
	return &ExecCmdTool{config: config}
}

func (t *ExecCmdTool) Name() string {
	return "exec_cmd"
}

func (t *ExecCmdTool) Description() string {
	return "Execute shell command in sandbox"
}

func (t *ExecCmdTool) Parameters() interface{} {
	return map[string]string{
		"command": "string (required) - shell command to execute",
	}
}

func (t *ExecCmdTool) Validate(args map[string]interface{}) error {
	cmd, ok := args["command"].(string)
	if !ok {
		cmd, ok = args["cmd"].(string)
	}
	if !ok || cmd == "" {
		return errors.New("command is required")
	}
	if security.IsDangerousCommand(cmd) {
		return errors.New("dangerous command blocked")
	}
	return nil
}

func getShell() (string, string) {
	if runtime.GOOS == "windows" {
		comspec := os.Getenv("COMSPEC")
		if comspec == "" {
			comspec = "cmd.exe"
		}
		return comspec, "/C"
	}
	return "sh", "-c"
}

func (t *ExecCmdTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}

	cmd, _ := ctx.Args["command"].(string)
	if cmd == "" {
		cmd, _ = ctx.Args["cmd"].(string)
	}

	execCtx, cancel := context.WithTimeout(
		context.Background(),
		time.Duration(t.config.Timeout)*time.Second,
	)
	defer cancel()

	shell, flag := getShell()
	proc := exec.CommandContext(execCtx, shell, flag, cmd)
	proc.Dir = t.config.RootDir
	output, err := proc.CombinedOutput()
	result.EndTime = time.Now()

	if execCtx.Err() == context.DeadlineExceeded {
		result.Status = "error"
		result.Error = "execution timeout"
		return result
	}

	outputStr, _ := Truncate(string(output))

	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		result.Output = outputStr
		return result
	}

	result.Status = "success"
	if outputStr == "" {
		outputStr = "empty"
	}
	result.Output = fmt.Sprintf("command: %s\n\n%s", cmd, outputStr)
	return result
}
