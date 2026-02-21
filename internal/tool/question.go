package tool

import (
	"fmt"
	"strings"
	"time"
)

type QuestionTool struct{}

func NewQuestionTool() *QuestionTool { return &QuestionTool{} }

func (t *QuestionTool) Name() string        { return "question" }
func (t *QuestionTool) Description() string { return "Ask the user a question and wait for input" }
func (t *QuestionTool) Parameters() interface{} {
	return map[string]string{
		"question": "string (required) - the question to ask",
		"options":  "array (optional) - list of choices to present",
	}
}

func (t *QuestionTool) Validate(args map[string]interface{}) error {
	if q, ok := args["question"].(string); !ok || q == "" {
		return fmt.Errorf("question is required")
	}
	return nil
}

func (t *QuestionTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	question, _ := ctx.Args["question"].(string)
	options, _ := ctx.Args["options"].([]interface{})

	var sb strings.Builder
	sb.WriteString("[需要您的输入]\n\n")
	sb.WriteString(question)

	if len(options) > 0 {
		sb.WriteString("\n\n可选项：")
		for i, opt := range options {
			sb.WriteString(fmt.Sprintf("\n  %d. %v", i+1, opt))
		}
		sb.WriteString("\n\n请输入您的选择或回答：")
	}

	result.Status = "success"
	result.Output = sb.String()
	result.EndTime = time.Now()
	return result
}
