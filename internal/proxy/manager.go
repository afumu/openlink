package proxy

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/afumu/openlink/internal/types"
)

var ErrTimeout = errors.New("proxy: timeout waiting for browser reply")
var ErrNoClient = errors.New("proxy: no SSE client connected")

// Manager 管理 LLM 代理请求队列和 SSE 客户端
type Manager struct {
	mu       sync.Mutex
	pending  map[string]*types.ProxyRequest
	// clientCh 是当前活跃的 SSE 客户端 channel，nil 表示无连接
	clientCh chan *types.ProxySSEEvent
}

func NewManager() *Manager {
	return &Manager{
		pending: make(map[string]*types.ProxyRequest),
	}
}

// RegisterSSEClient 插件建立 SSE 连接时调用。
// 每次调用都创建新的 channel，替换旧连接，避免多个 goroutine 共享同一 channel。
// 返回事件 channel 和注销函数；注销时会取消所有挂起请求。
func (m *Manager) RegisterSSEClient() (<-chan *types.ProxySSEEvent, func()) {
	ch := make(chan *types.ProxySSEEvent, 8)

	m.mu.Lock()
	m.clientCh = ch
	m.mu.Unlock()

	unregister := func() {
		m.mu.Lock()
		// 只有当前连接才清空 clientCh，避免新连接被旧连接的注销覆盖
		if m.clientCh == ch {
			m.clientCh = nil
		}
		// 取出所有挂起请求，在锁外发送错误信号
		pending := m.pending
		m.pending = make(map[string]*types.ProxyRequest)
		m.mu.Unlock()

		// 通知所有等待中的请求：连接已断开
		for _, req := range pending {
			select {
			case req.ReplyCh <- "[proxy error] SSE client disconnected":
			default:
			}
		}
	}
	return ch, unregister
}

// Submit 外部客户端提交请求，返回 ProxyRequest（含等待 reply 的 channel）
func (m *Manager) Submit(format, prompt string) (*types.ProxyRequest, error) {
	m.mu.Lock()
	ch := m.clientCh
	if ch == nil {
		m.mu.Unlock()
		return nil, ErrNoClient
	}
	id, err := newID()
	if err != nil {
		m.mu.Unlock()
		return nil, fmt.Errorf("proxy: failed to generate request id: %w", err)
	}
	req := &types.ProxyRequest{
		ID:        id,
		CreatedAt: time.Now(),
		Format:    format,
		Prompt:    prompt,
		ReplyCh:   make(chan string, 1),
	}
	m.pending[id] = req
	m.mu.Unlock()

	select {
	case ch <- &types.ProxySSEEvent{RequestID: id, Prompt: prompt}:
	default:
		m.mu.Lock()
		delete(m.pending, id)
		m.mu.Unlock()
		return nil, ErrNoClient
	}
	return req, nil
}

// Deliver 插件回传结果，唤醒挂起的请求
func (m *Manager) Deliver(requestID, content string) bool {
	m.mu.Lock()
	req, ok := m.pending[requestID]
	if ok {
		delete(m.pending, requestID)
	}
	m.mu.Unlock()
	if !ok {
		return false
	}
	req.ReplyCh <- content
	return true
}

// WaitReply 阻塞等待插件回传，带超时
func (m *Manager) WaitReply(req *types.ProxyRequest, timeout time.Duration) (string, error) {
	select {
	case reply := <-req.ReplyCh:
		return reply, nil
	case <-time.After(timeout):
		m.mu.Lock()
		delete(m.pending, req.ID)
		m.mu.Unlock()
		return "", ErrTimeout
	}
}

func newID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
