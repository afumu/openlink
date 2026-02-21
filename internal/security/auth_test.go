package security

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestLoadOrCreateToken(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)

	// First call creates token
	token1, err := LoadOrCreateToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(token1) == 0 {
		t.Fatal("expected non-empty token")
	}

	// Second call returns same token
	token2, err := LoadOrCreateToken()
	if err != nil {
		t.Fatal(err)
	}
	if token1 != token2 {
		t.Errorf("expected same token, got %q vs %q", token1, token2)
	}
}

func TestLoadOrCreateTokenExisting(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)

	settingsDir := filepath.Join(dir, ".openlink")
	os.MkdirAll(settingsDir, 0700)
	os.WriteFile(filepath.Join(settingsDir, "settings.json"), []byte(`{"token":"mytoken123"}`), 0600)

	token, err := LoadOrCreateToken()
	if err != nil {
		t.Fatal(err)
	}
	if token != "mytoken123" {
		t.Errorf("expected mytoken123, got %q", token)
	}
}

func TestAuthMiddleware(t *testing.T) {
	gin.SetMode(gin.TestMode)

	handler := AuthMiddleware("secret")
	router := gin.New()
	router.Use(handler)
	router.GET("/health", func(c *gin.Context) { c.Status(200) })
	router.GET("/auth", func(c *gin.Context) { c.Status(200) })
	router.GET("/protected", func(c *gin.Context) { c.Status(200) })

	t.Run("health bypasses auth", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/health", nil)
		router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", w.Code)
		}
	})

	t.Run("auth endpoint bypasses auth", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/auth", nil)
		router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", w.Code)
		}
	})

	t.Run("protected without token returns 401", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/protected", nil)
		router.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d", w.Code)
		}
	})

	t.Run("protected with valid token returns 200", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/protected", nil)
		req.Header.Set("Authorization", "Bearer secret")
		router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", w.Code)
		}
	})

	t.Run("protected with wrong token returns 401", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/protected", nil)
		req.Header.Set("Authorization", "Bearer wrong")
		router.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d", w.Code)
		}
	})
}
