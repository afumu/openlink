package skill

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
)

type Info struct {
	Name        string
	Description string
	Dir         string
	Location    string // absolute path to SKILL.md
}

func SkillDirs(rootDir string) []string {
	home, _ := os.UserHomeDir()
	return []string{
		filepath.Join(rootDir, ".skills"),
		filepath.Join(rootDir, ".openlink", "skills"),
		filepath.Join(rootDir, ".agent", "skills"),
		filepath.Join(rootDir, ".claude", "skills"),
		filepath.Join(home, ".openlink", "skills"),
		filepath.Join(home, ".agent", "skills"),
		filepath.Join(home, ".claude", "skills"),
	}
}

func LoadInfos(rootDir string) []Info {
	seen := map[string]Info{}
	var order []string

	for _, dir := range SkillDirs(rootDir) {
		if _, err := os.Stat(dir); err != nil {
			continue
		}
		log.Printf("[Skill] 扫描目录: %s", dir)
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			// 跟随软链接：用 os.Stat 而非 entry.Type()
			subPath := filepath.Join(dir, entry.Name())
			info, err := os.Stat(subPath)
			if err != nil || !info.IsDir() {
				continue
			}
			skillFile := findSkillMd(subPath)
			if skillFile == "" {
				continue
			}
			data, err := os.ReadFile(skillFile)
			if err != nil {
				continue
			}
			sk := parse(skillFile, string(data))
			sk.Dir = subPath
			sk.Location = skillFile
			log.Printf("[Skill] 加载: name=%s description=%.60s", sk.Name, sk.Description)
			if _, exists := seen[sk.Name]; !exists {
				order = append(order, sk.Name)
			}
			seen[sk.Name] = sk
		}
	}

	log.Printf("[Skill] 共加载 %d 个 skill", len(order))
	result := make([]Info, 0, len(order))
	for _, name := range order {
		result = append(result, seen[name])
	}
	return result
}

func Get(rootDir, name string) (Info, bool) {
	if strings.ContainsAny(name, "/\\") || strings.Contains(name, "..") {
		return Info{}, false
	}
	for _, info := range LoadInfos(rootDir) {
		if strings.EqualFold(info.Name, name) {
			return info, true
		}
	}
	return Info{}, false
}

func FindSkill(rootDir, name string) (content, dir string, err error) {
	if strings.ContainsAny(name, "/\\") || strings.Contains(name, "..") {
		return "", "", fmt.Errorf("invalid skill name: %q", name)
	}
	for _, d := range SkillDirs(rootDir) {
		// flat file: dir/<name>.md
		p := filepath.Join(d, name+".md")
		if data, e := os.ReadFile(p); e == nil {
			return string(data), d, nil
		}
		// subdir: dir/<name>/SKILL.md (case-insensitive match on dir name)
		entries, e := os.ReadDir(d)
		if e != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() && strings.EqualFold(entry.Name(), name) {
				skillPath := filepath.Join(d, entry.Name(), "SKILL.md")
				if data, e := os.ReadFile(skillPath); e == nil {
					return string(data), filepath.Join(d, entry.Name()), nil
				}
			}
		}
	}
	return "", "", fmt.Errorf("skill %q not found", name)
}

// findSkillMd 在目录下查找 SKILL.md（大小写不敏感）
func findSkillMd(dir string) string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	for _, e := range entries {
		if !e.IsDir() && strings.EqualFold(e.Name(), "skill.md") {
			return filepath.Join(dir, e.Name())
		}
	}
	return ""
}

func parse(path, content string) Info {
	name := filepath.Base(filepath.Dir(path))
	description := ""

	if !strings.HasPrefix(content, "---") {
		return Info{Name: name, Description: description}
	}
	end := strings.Index(content[3:], "---")
	if end < 0 {
		return Info{Name: name, Description: description}
	}
	front := content[3 : end+3]
	for _, line := range strings.Split(front, "\n") {
		line = strings.TrimSpace(line)
		if k, v, ok := strings.Cut(line, ":"); ok {
			v = strings.TrimSpace(v)
			switch strings.TrimSpace(k) {
			case "name":
				name = v
			case "description":
				description = v
			}
		}
	}
	return Info{Name: name, Description: description}
}
