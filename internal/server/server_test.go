package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/afumu/openlink/internal/types"
)

func testServer(t *testing.T) *Server {
	t.Helper()
	cfg := &types.Config{
		RootDir: t.TempDir(),
		Port:    8080,
		Timeout: 10,
		Token:   "testtoken",
	}
	return New(cfg)
}

func TestHandleHealth(t *testing.T) {
	s := testServer(t)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/health", nil)
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestAuthMiddleware(t *testing.T) {
	s := testServer(t)

	t.Run("missing token returns 401", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/config", nil)
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d", w.Code)
		}
	})

	t.Run("valid token returns 200", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/config", nil)
		req.Header.Set("Authorization", "Bearer testtoken")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", w.Code)
		}
	})

	t.Run("wrong token returns 401", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/config", nil)
		req.Header.Set("Authorization", "Bearer wrongtoken")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d", w.Code)
		}
	})
}

func TestHandleExec(t *testing.T) {
	s := testServer(t)

	t.Run("exec_cmd succeeds", func(t *testing.T) {
		body, _ := json.Marshal(types.ToolRequest{
			Name: "exec_cmd",
			Args: map[string]interface{}{"command": "echo hi"},
		})
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/exec", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer testtoken")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", w.Code)
		}
		var resp types.ToolResponse
		json.NewDecoder(w.Body).Decode(&resp)
		if resp.Status != "success" {
			t.Errorf("expected success, got %s: %s", resp.Status, resp.Error)
		}
	})

	t.Run("invalid json returns 400", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/exec", bytes.NewReader([]byte("bad json")))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer testtoken")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d", w.Code)
		}
	})
}

func TestHandleAuth(t *testing.T) {
	s := testServer(t)

	t.Run("valid token returns valid=true", func(t *testing.T) {
		body, _ := json.Marshal(map[string]string{"token": "testtoken"})
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/auth", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", w.Code)
		}
		var resp map[string]interface{}
		json.NewDecoder(w.Body).Decode(&resp)
		if resp["valid"] != true {
			t.Errorf("expected valid=true, got %v", resp["valid"])
		}
	})

	t.Run("wrong token returns valid=false", func(t *testing.T) {
		body, _ := json.Marshal(map[string]string{"token": "wrong"})
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/auth", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		s.router.ServeHTTP(w, req)
		var resp map[string]interface{}
		json.NewDecoder(w.Body).Decode(&resp)
		if resp["valid"] != false {
			t.Errorf("expected valid=false, got %v", resp["valid"])
		}
	})

	t.Run("invalid json returns 400", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/auth", bytes.NewReader([]byte("bad")))
		req.Header.Set("Content-Type", "application/json")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d", w.Code)
		}
	})
}

func TestHandleListTools(t *testing.T) {
	s := testServer(t)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/tools", nil)
	req.Header.Set("Authorization", "Bearer testtoken")
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	var resp map[string]interface{}
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["tools"] == nil {
		t.Error("expected tools in response")
	}
}

func TestHandlePrompt(t *testing.T) {
	s := testServer(t)

	t.Run("missing init_prompt.txt returns 404", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/prompt", nil)
		req.Header.Set("Authorization", "Bearer testtoken")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %d", w.Code)
		}
	})

	t.Run("existing init_prompt.txt returns content", func(t *testing.T) {
		os.WriteFile(filepath.Join(s.config.RootDir, "init_prompt.txt"), []byte("hello prompt"), 0644)
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/prompt", nil)
		req.Header.Set("Authorization", "Bearer testtoken")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", w.Code)
		}
		if !bytes.Contains(w.Body.Bytes(), []byte("hello prompt")) {
			t.Errorf("expected prompt content in response")
		}
	})
}

func TestCORSOptions(t *testing.T) {
	s := testServer(t)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("OPTIONS", "/exec", nil)
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusNoContent {
		t.Errorf("expected 204, got %d", w.Code)
	}
}
