import { useEffect, useState } from 'react'

export default function App() {
  const [status, setStatus] = useState<'checking' | 'connected' | 'disconnected'>('checking')
  const [token, setToken] = useState('')
  const [savedToken, setSavedToken] = useState('')
  const [apiUrl, setApiUrl] = useState('')
  const [info, setInfo] = useState('')

  useEffect(() => {
    chrome.storage.local.get(['authToken', 'apiUrl'], (result) => {
      if (result.authToken && result.apiUrl) {
        setSavedToken(result.authToken)
        setApiUrl(result.apiUrl)
        checkConnection(result.authToken, result.apiUrl)
      } else {
        setStatus('disconnected')
        setInfo('请输入认证 Token URL')
      }
    })
  }, [])

  const checkConnection = (authToken: string, url: string) => {
    fetch(`${url}/health`)
      .then(res => res.json())
      .then(data => {
        setStatus('connected')
        setInfo(`工作目录: ${data.dir || 'unknown'}`)
      })
      .catch(() => {
        setStatus('disconnected')
        setInfo('服务未运行')
      })
  }

  const handleConnect = async () => {
    if (!token) return

    try {
      const url = new URL(token)
      const tokenValue = url.searchParams.get('token')
      const baseUrl = `${url.protocol}//${url.host}`

      if (!tokenValue) {
        setInfo('URL 格式错误')
        return
      }

      const res = await fetch(`${baseUrl}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokenValue })
      })
      const data = await res.json()

      if (data.valid) {
        chrome.storage.local.set({ authToken: tokenValue, apiUrl: baseUrl })
        setSavedToken(tokenValue)
        setApiUrl(baseUrl)
        checkConnection(tokenValue, baseUrl)
      } else {
        setInfo('Token 无效')
      }
    } catch {
      setInfo('URL 格式错误或连接失败')
    }
  }

  return (
    <>
      <h3>🤖 OpenLink</h3>
      <div className="status">
        <div className={`dot ${status === 'connected' ? 'connected' : 'disconnected'}`} />
        <span>{status === 'checking' ? '检查中...' : status === 'connected' ? '已连接' : '未连接'}</span>
      </div>

      {status !== 'connected' && (
        <div style={{ marginTop: '10px' }}>
          <input
            type="password"
            placeholder="输入 Token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            style={{ width: '100%', padding: '5px', marginBottom: '5px' }}
          />
          <button onClick={handleConnect} style={{ width: '100%', padding: '5px' }}>
            连接
          </button>
        </div>
      )}

      <div style={{ marginTop: '10px', fontSize: '12px' }}>{info}</div>
    </>
  )
}
