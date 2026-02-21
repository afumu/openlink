package tool

import (
	"testing"
)

func TestReplaceInContent(t *testing.T) {
	t.Run("exact match replace once", func(t *testing.T) {
		got, err := replaceInContent("hello world", "world", "go", false)
		if err != nil || got != "hello go" {
			t.Errorf("got %q, err %v", got, err)
		}
	})

	t.Run("replace all occurrences", func(t *testing.T) {
		got, err := replaceInContent("a a a", "a", "b", true)
		if err != nil || got != "b b b" {
			t.Errorf("got %q, err %v", got, err)
		}
	})

	t.Run("old_string not found returns error", func(t *testing.T) {
		_, err := replaceInContent("hello", "missing", "x", false)
		if err == nil {
			t.Error("expected error")
		}
	})

	t.Run("crlf normalized match", func(t *testing.T) {
		_, err := replaceInContent("a\r\nb", "a\nb", "x", false)
		if err != nil {
			t.Errorf("expected crlf-normalized match to succeed, got %v", err)
		}
	})

	t.Run("whitespace-trimmed line match", func(t *testing.T) {
		got, err := replaceInContent("  hello\n  world\n", "hello\nworld", "hi\nthere", false)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got == "" {
			t.Error("expected non-empty result")
		}
	})
}
