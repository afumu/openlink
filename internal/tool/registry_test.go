package tool

import (
	"testing"
)

type mockTool struct{ name string }

func (m *mockTool) Name() string             { return m.name }
func (m *mockTool) Description() string      { return "mock" }
func (m *mockTool) Parameters() interface{}  { return nil }
func (m *mockTool) Validate(map[string]interface{}) error { return nil }
func (m *mockTool) Execute(*Context) *Result { return &Result{Status: "success"} }

func TestRegistry(t *testing.T) {
	t.Run("register and get", func(t *testing.T) {
		r := NewRegistry()
		r.Register(&mockTool{"foo"})
		tool, ok := r.Get("foo")
		if !ok || tool.Name() != "foo" {
			t.Error("expected to get registered tool")
		}
	})

	t.Run("duplicate registration returns error", func(t *testing.T) {
		r := NewRegistry()
		r.Register(&mockTool{"foo"})
		err := r.Register(&mockTool{"foo"})
		if err == nil {
			t.Error("expected error for duplicate")
		}
	})

	t.Run("get unknown tool returns false", func(t *testing.T) {
		r := NewRegistry()
		_, ok := r.Get("unknown")
		if ok {
			t.Error("expected not found")
		}
	})

	t.Run("list returns all tools", func(t *testing.T) {
		r := NewRegistry()
		r.Register(&mockTool{"a"})
		r.Register(&mockTool{"b"})
		if len(r.List()) != 2 {
			t.Errorf("expected 2 tools, got %d", len(r.List()))
		}
	})
}
