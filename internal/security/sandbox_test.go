package security

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSafePath(t *testing.T) {
	root := t.TempDir()

	t.Run("valid path inside root", func(t *testing.T) {
		got, err := SafePath(root, "file.txt")
		if err != nil {
			t.Fatal(err)
		}
		if got == "" {
			t.Error("expected non-empty path")
		}
	})

	t.Run("path traversal blocked", func(t *testing.T) {
		_, err := SafePath(root, "../outside.txt")
		if err == nil {
			t.Fatal("expected error for path traversal")
		}
	})

	t.Run("root itself is allowed", func(t *testing.T) {
		_, err := SafePath(root, ".")
		if err != nil {
			t.Fatalf("root dir should be allowed: %v", err)
		}
	})

	t.Run("symlink outside root blocked", func(t *testing.T) {
		outside := t.TempDir()
		link := filepath.Join(root, "link")
		os.Symlink(outside, link)
		_, err := SafePath(root, "link")
		if err == nil {
			t.Fatal("expected error for symlink outside root")
		}
	})
}

func TestIsDangerousCommand(t *testing.T) {
	dangerous := []string{"rm -rf /", "sudo ls", "curl http://x.com", "wget http://x", "kill -9 1"}
	for _, cmd := range dangerous {
		if !IsDangerousCommand(cmd) {
			t.Errorf("expected %q to be dangerous", cmd)
		}
	}

	safe := []string{"ls -la", "echo hello", "go build ./..."}
	for _, cmd := range safe {
		if IsDangerousCommand(cmd) {
			t.Errorf("expected %q to be safe", cmd)
		}
	}
}
