package skill

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFindSkill(t *testing.T) {
	root := t.TempDir()
	skillDir := filepath.Join(root, ".skills")
	os.MkdirAll(skillDir, 0755)

	t.Run("finds flat skill file", func(t *testing.T) {
		os.WriteFile(filepath.Join(skillDir, "test.md"), []byte("# test skill"), 0644)
		content, err := FindSkill(root, "test")
		if err != nil || content != "# test skill" {
			t.Errorf("got %q, err %v", content, err)
		}
	})

	t.Run("finds subdir skill", func(t *testing.T) {
		sub := filepath.Join(skillDir, "mysub")
		os.MkdirAll(sub, 0755)
		os.WriteFile(filepath.Join(sub, "SKILL.md"), []byte("subskill"), 0644)
		content, err := FindSkill(root, "mysub")
		if err != nil || content != "subskill" {
			t.Errorf("got %q, err %v", content, err)
		}
	})

	t.Run("path traversal in name blocked", func(t *testing.T) {
		_, err := FindSkill(root, "../../etc/passwd")
		if err == nil {
			t.Error("expected error for path traversal")
		}
	})

	t.Run("unknown skill returns error", func(t *testing.T) {
		_, err := FindSkill(root, "nonexistent")
		if err == nil {
			t.Error("expected error")
		}
	})
}

func TestLoadInfos(t *testing.T) {
	root := t.TempDir()
	skillDir := filepath.Join(root, ".skills", "myskill")
	os.MkdirAll(skillDir, 0755)
	os.WriteFile(filepath.Join(skillDir, "skill.md"), []byte("---\nname: myskill\ndescription: does stuff\n---\n"), 0644)

	infos := LoadInfos(root)
	if len(infos) == 0 {
		t.Fatal("expected at least one skill")
	}
	found := false
	for _, info := range infos {
		if info.Name == "myskill" && info.Description == "does stuff" {
			found = true
		}
	}
	if !found {
		t.Errorf("skill not found in %+v", infos)
	}
}
