package tool

import (
	"time"

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
	Status    string
	Output    string
	Error     string
	StartTime time.Time
	EndTime   time.Time
}

type ToolInfo struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	Parameters  interface{} `json:"parameters,omitempty"`
}
