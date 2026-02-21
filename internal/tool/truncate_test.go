package tool

import (
	"strings"
	"testing"
)

func TestTruncate(t *testing.T) {
	t.Run("short output not truncated", func(t *testing.T) {
		out, truncated := Truncate("hello")
		if truncated {
			t.Error("expected not truncated")
		}
		if out != "hello" {
			t.Errorf("got %q", out)
		}
	})

	t.Run("many lines triggers truncation", func(t *testing.T) {
		lines := strings.Repeat("line\n", MaxLines+10)
		out, truncated := Truncate(lines)
		if !truncated {
			t.Error("expected truncated")
		}
		if !strings.Contains(out, "截断") {
			t.Error("expected truncation hint in output")
		}
	})

	t.Run("large bytes triggers truncation", func(t *testing.T) {
		big := strings.Repeat("x", MaxBytes+1)
		_, truncated := Truncate(big)
		if !truncated {
			t.Error("expected truncated")
		}
	})
}
