package tool

import "fmt"

type InvalidTool struct{}

func (t *InvalidTool) Name() string                               { return "invalid" }
func (t *InvalidTool) Description() string                        { return "Catches unknown tool calls" }
func (t *InvalidTool) Parameters() interface{}                    { return nil }
func (t *InvalidTool) Validate(args map[string]interface{}) error { return nil }
func (t *InvalidTool) Execute(ctx *Context) *Result {
	toolName, _ := ctx.Args["tool"].(string)
	return &Result{
		Status: "error",
		Error:  fmt.Sprintf("工具 '%s' 不存在。可用工具: exec_cmd, read_file, write_file, list_dir, glob, grep, edit, web_fetch, todo_write, question, skill", toolName),
	}
}
