package tool

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/afumu/openlink/internal/security"
	"github.com/afumu/openlink/internal/types"
)

type SkillTool struct {
	config *types.Config
}

func NewSkillTool(config *types.Config) *SkillTool {
	return &SkillTool{config: config}
}

func (t *SkillTool) Name() string        { return "skill" }
func (t *SkillTool) Description() string { return "Load a skill file from .skills/ directory" }
func (t *SkillTool) Parameters() interface{} {
	return map[string]string{
		"skill": "string (optional) - skill name to load; omit to list available skills",
	}
}

func (t *SkillTool) Validate(args map[string]interface{}) error { return nil }

func (t *SkillTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	skillName, _ := ctx.Args["skill"].(string)

	if skillName == "" {
		return t.listSkills(result)
	}

	skillPath, err := security.SafePath(ctx.Config.RootDir,
		filepath.Join(".skills", skillName+".md"))
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	content, err := os.ReadFile(skillPath)
	if err != nil {
		return t.listSkills(result)
	}

	result.Status = "success"
	result.Output = string(content)
	result.EndTime = time.Now()
	return result
}

func (t *SkillTool) listSkills(result *Result) *Result {
	skillsDir := filepath.Join(t.config.RootDir, ".skills")
	entries, err := os.ReadDir(skillsDir)
	if err != nil {
		result.Status = "error"
		result.Error = fmt.Sprintf("未找到 .skills 目录，请在 rootDir 下创建 .skills/ 目录并放入 .md 文件")
		return result
	}
	var names []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".md") {
			names = append(names, strings.TrimSuffix(e.Name(), ".md"))
		}
	}
	result.Status = "success"
	result.Output = "可用 skills: " + strings.Join(names, ", ")
	result.EndTime = time.Now()
	return result
}
