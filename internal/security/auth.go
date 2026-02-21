package security

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/afumu/openlink/internal/types"
	"github.com/gin-gonic/gin"
)

func LoadOrCreateToken() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}

	dir := filepath.Join(home, ".openlink")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}

	path := filepath.Join(dir, "settings.json")
	data, err := os.ReadFile(path)
	if err == nil {
		var settings types.Settings
		if err := json.Unmarshal(data, &settings); err == nil && settings.Token != "" {
			return settings.Token, nil
		}
	}

	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("failed to generate token: %w", err)
	}
	token := hex.EncodeToString(b)
	settings := types.Settings{
		Token:     token,
		CreatedAt: time.Now().Format(time.RFC3339),
	}

	data, err = json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return "", fmt.Errorf("failed to marshal settings: %w", err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		return "", fmt.Errorf("failed to write token file: %w", err)
	}
	return token, nil
}

func AuthMiddleware(token string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.URL.Path == "/health" || c.Request.URL.Path == "/auth" {
			c.Next()
			return
		}

		auth := c.GetHeader("Authorization")
		expected := "Bearer " + token
		if len(auth) != len(expected) || subtle.ConstantTimeCompare([]byte(auth), []byte(expected)) != 1 {
			c.JSON(401, gin.H{"error": "unauthorized"})
			c.Abort()
			return
		}
		c.Next()
	}
}
