package tool

import (
	"testing"
)

func TestReplace(t *testing.T) {
	t.Run("exact match replace once", func(t *testing.T) {
		got, err := replace("hello world", "world", "go", false)
		if err != nil || got != "hello go" {
			t.Errorf("got %q, err %v", got, err)
		}
	})

	t.Run("replace all occurrences", func(t *testing.T) {
		got, err := replace("a a a", "a", "b", true)
		if err != nil || got != "b b b" {
			t.Errorf("got %q, err %v", got, err)
		}
	})

	t.Run("old_string not found returns error", func(t *testing.T) {
		_, err := replace("hello", "missing", "x", false)
		if err == nil {
			t.Error("expected error")
		}
	})

	t.Run("crlf normalized match", func(t *testing.T) {
		content := normalizeLineEndings("a\r\nb")
		_, err := replace(content, "a\nb", "x", false)
		if err != nil {
			t.Errorf("expected crlf-normalized match to succeed, got %v", err)
		}
	})

	t.Run("whitespace-trimmed line match", func(t *testing.T) {
		got, err := replace("  hello\n  world\n", "hello\nworld", "hi\nthere", false)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got == "" {
			t.Error("expected non-empty result")
		}
	})

	t.Run("identical old and new returns error", func(t *testing.T) {
		_, err := replace("hello", "hello", "hello", false)
		if err == nil {
			t.Error("expected error for identical strings")
		}
	})

	t.Run("multiple matches returns error", func(t *testing.T) {
		_, err := replace("foo foo", "foo", "bar", false)
		if err == nil {
			t.Error("expected error for multiple matches")
		}
	})

	t.Run("indentation flexible match", func(t *testing.T) {
		content := "func main() {\n\t\tfmt.Println(\"hello\")\n\t}"
		find := "func main() {\n\tfmt.Println(\"hello\")\n}"
		_, err := replace(content, find, "replaced", false)
		if err != nil {
			t.Errorf("IndentationFlexibleReplacer should match, got %v", err)
		}
	})

	t.Run("escape normalized match", func(t *testing.T) {
		content := "line1\nline2\nline3"
		find := "line1\\nline2\\nline3"
		_, err := replace(content, find, "replaced", false)
		if err != nil {
			t.Errorf("EscapeNormalizedReplacer should match, got %v", err)
		}
	})

	t.Run("trimmed boundary match", func(t *testing.T) {
		content := "  hello world  "
		find := "  hello world  \n"
		_, err := replace(content, find, "replaced", false)
		if err != nil {
			t.Errorf("TrimmedBoundaryReplacer should match, got %v", err)
		}
	})
}
