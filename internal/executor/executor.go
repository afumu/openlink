package executor

import (
	"context"
	"fmt"
	"log"
	"strings"

	"github.com/afumu/openlink/internal/tool"
	"github.com/afumu/openlink/internal/types"
)

type Executor struct {
	config   *types.Config
	registry *tool.Registry
}

func New(config *types.Config) *Executor {
	e := &Executor{
		config:   config,
		registry: tool.NewRegistry(),
	}
	e.registry.Register(tool.NewExecCmdTool(config))
	e.registry.Register(tool.NewListDirTool(config))
	e.registry.Register(tool.NewReadFileTool(config))
	e.registry.Register(tool.NewWriteFileTool(config))
	e.registry.Register(tool.NewGlobTool(config))
	e.registry.Register(tool.NewGrepTool(config))
	e.registry.Register(tool.NewEditTool(config))
	e.registry.Register(tool.NewWebFetchTool())
	e.registry.Register(tool.NewQuestionTool())
	e.registry.Register(tool.NewSkillTool(config))
	e.registry.Register(tool.NewTodoWriteTool(config))
	return e
}

func (e *Executor) Execute(ctx context.Context, req *types.ToolRequest) *types.ToolResponse {
	log.Printf("[Executor] 执行工具: %s\n", req.Name)

	t, exists := e.registry.Get(req.Name)
	if !exists {
		t, exists = e.registry.Get(strings.ToLower(req.Name))
	}
	if !exists {
		invalid := &tool.InvalidTool{}
		args := req.Args
		if args == nil {
			args = map[string]interface{}{}
		}
		args["tool"] = req.Name
		return &types.ToolResponse{
			Status: "error",
			Error:  invalid.Execute(&tool.Context{Args: args, Config: e.config}).Error,
		}
	}

	if err := t.Validate(req.Args); err != nil {
		return &types.ToolResponse{
			Status: "error",
			Error:  fmt.Sprintf("validation failed: %s", err),
		}
	}

	result := t.Execute(&tool.Context{
		Args:   req.Args,
		Config: e.config,
	})

	return &types.ToolResponse{
		Status: result.Status,
		Output: result.Output,
		Error:  result.Error,
	}
}

func (e *Executor) ListTools() []tool.ToolInfo {
	return e.registry.List()
}
