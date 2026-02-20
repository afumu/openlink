package main

import (
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/afumu/ground-link/internal/security"
	"github.com/afumu/ground-link/internal/server"
	"github.com/afumu/ground-link/internal/types"
)

func main() {
	cwd, err := os.Getwd()
	if err != nil {
		log.Fatal(err)
	}
	dir := flag.String("dir", cwd, "工作目录")
	port := flag.Int("port", 8080, "端口")
	timeout := flag.Int("timeout", 60, "超时(秒)")
	flag.Parse()

	token, err := security.LoadOrCreateToken()
	if err != nil {
		log.Fatal(err)
	}

	config := &types.Config{
		RootDir: *dir,
		Port:    *port,
		Timeout: *timeout,
		Token:   token,
	}

	log.Printf("启动 ground-link server...")
	log.Printf("工作目录: %s", config.RootDir)
	log.Printf("端口: %d", config.Port)
	fmt.Printf("\n认证 URL: http://127.0.0.1:%d/auth?token=%s\n", *port, token)
	fmt.Printf("请在浏览器扩展中输入此 URL\n\n")

	srv := server.New(config)
	if err := srv.Run(); err != nil {
		log.Fatal(err)
	}
}
