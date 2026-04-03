import { useEffect, useState } from 'react'

export default function App() {
  const [status, setStatus] = useState<'checking' | 'connected' | 'disconnected'>('checking')
  const [token, setToken] = useState('')
  const [savedToken, setSavedToken] = useState('')
  const [apiUrl, setApiUrl] = useState('')
  const [reconfig, setReconfig] = useState(false)
  const [info, setInfo] = useState('')
  const [autoSend, setAutoSend] = useState(true)
  const [autoExecute, setAutoExecute] = useState(false)
  const [delayMin, setDelayMin] = useState(1)
  const [delayMax, setDelayMax] = useState(4)
  const [debugMode, setDebugMode] = useState(false)

  useEffect(() => {
    chrome.storage.local.get(['authToken', 'apiUrl', 'autoSend', 'autoExecute', 'delayMin', 'delayMax', 'debugMode'], (result) => {
      if (result.authToken && result.apiUrl) {
        setSavedToken(result.authToken)
        setApiUrl(result.apiUrl)
        checkConnection(result.authToken, result.apiUrl)
      } else {
        setStatus('disconnected')
        setInfo('请输入认证 Token URL')
      }
      if (result.autoSend !== undefined) setAutoSend(result.autoSend)
      if (result.autoExecute !== undefined) setAutoExecute(result.autoExecute)
      if (result.delayMin !== undefined) setDelayMin(result.delayMin)
      if (result.delayMax !== undefined) setDelayMax(result.delayMax)
      if (result.debugMode !== undefined) setDebugMode(result.debugMode)
    })
  }, [])

  const checkConnection = (authToken: string, url: string) => {
    fetch(`${url}/health`)
      .then(res => res.json())
      .then(data => { setStatus('connected'); setInfo(`工作目录: ${data.dir || 'unknown'}`) })
      .catch(() => { setStatus('disconnected'); setInfo('服务未运行') })
  }

  const handleConnect = async () => {
    if (!token) return
    try {
      const url = new URL(token)
      const tokenValue = url.searchParams.get('token')
      const baseUrl = `${url.protocol}//${url.host}`
      if (!tokenValue) { setInfo('URL 格式错误'); return }
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
        setReconfig(false)
        checkConnection(tokenValue, baseUrl)
      } else {
        setInfo('Token 无效')
      }
    } catch {
      setInfo('URL 格式错误或连接失败')
    }
  }

  const handleAutoSendChange = (val: boolean) => {
    setAutoSend(val)
    chrome.storage.local.set({ autoSend: val })
  }

  const handleAutoExecuteChange = (val: boolean) => {
    setAutoExecute(val)
    chrome.storage.local.set({ autoExecute: val })
  }

  const handleDelayChange = (min: number, max: number) => {
    const safeMin = Math.max(0, min)
    const safeMax = Math.max(safeMin, max)
    setDelayMin(safeMin)
    setDelayMax(safeMax)
    chrome.storage.local.set({ delayMin: safeMin, delayMax: safeMax })
  }

  const handleDebugModeChange = (val: boolean) => {
    setDebugMode(val)
    chrome.storage.local.set({ debugMode: val })
  }

  const statusColor = status === 'connected' ? 'bg-emerald-400' : status === 'checking' ? 'bg-yellow-400' : 'bg-red-400'
  const statusText = status === 'checking' ? '检查中...' : status === 'connected' ? '已连接' : '未连接'

  return (
    <div className="w-72 bg-gray-950 text-gray-100 p-4 font-sans">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="text-lg">🔗</span>
          <span className="font-semibold text-white tracking-wide">OpenLink</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${statusColor} ${status === 'checking' ? 'animate-pulse' : ''}`} />
          <span className="text-xs text-gray-400">{statusText}</span>
          {status === 'connected' && (
            <button
              onClick={() => { setReconfig(!reconfig); setToken('') }}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors cursor-pointer"
            >
              {reconfig ? '取消' : '重新配置'}
            </button>
          )}
        </div>
      </div>

      {/* Connect form */}
      {(status !== 'connected' || reconfig) && (
        <div className="mb-4 space-y-2">
          <input
            type="password"
            placeholder="粘贴 Token URL"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-blue-500 transition-colors"
          />
          <button
            onClick={handleConnect}
            className="w-full bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white text-sm font-medium rounded-lg py-2 transition-colors cursor-pointer"
          >
            连接
          </button>
        </div>
      )}

      {/* Divider */}
      <div className="border-t border-gray-800 my-3" />

      {/* Auto send toggle */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-300">自动执行工具</span>
          <button
            onClick={() => handleAutoExecuteChange(!autoExecute)}
            className={`relative inline-flex w-11 h-6 rounded-full transition-colors duration-200 cursor-pointer flex-shrink-0 ${autoExecute ? 'bg-blue-600' : 'bg-gray-600'}`}
          >
            <span className={`inline-block w-5 h-5 mt-0.5 bg-white rounded-full shadow transition-transform duration-200 ${autoExecute ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-300">自动提交</span>
          <button
            onClick={() => handleAutoSendChange(!autoSend)}
            className={`relative inline-flex w-11 h-6 rounded-full transition-colors duration-200 cursor-pointer flex-shrink-0 ${autoSend ? 'bg-blue-600' : 'bg-gray-600'}`}
          >
            <span className={`inline-block w-5 h-5 mt-0.5 bg-white rounded-full shadow transition-transform duration-200 ${autoSend ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-300">调试模式</span>
          <button
            onClick={() => handleDebugModeChange(!debugMode)}
            className={`relative inline-flex w-11 h-6 rounded-full transition-colors duration-200 cursor-pointer flex-shrink-0 ${debugMode ? 'bg-emerald-600' : 'bg-gray-600'}`}
          >
            <span className={`inline-block w-5 h-5 mt-0.5 bg-white rounded-full shadow transition-transform duration-200 ${debugMode ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>

        {autoSend && (
          <div className="bg-gray-900 rounded-lg p-3 space-y-2">
            <span className="text-xs text-gray-400">随机延迟（秒）</span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                value={delayMin}
                onChange={(e) => handleDelayChange(Number(e.target.value), delayMax)}
                className="w-16 bg-gray-800 border border-gray-700 rounded-md px-2 py-1 text-sm text-center text-gray-100 outline-none focus:border-blue-500 transition-colors"
              />
              <span className="text-gray-500 text-sm">~</span>
              <input
                type="number"
                min={0}
                value={delayMax}
                onChange={(e) => handleDelayChange(delayMin, Number(e.target.value))}
                className="w-16 bg-gray-800 border border-gray-700 rounded-md px-2 py-1 text-sm text-center text-gray-100 outline-none focus:border-blue-500 transition-colors"
              />
              <span className="text-xs text-gray-500">秒</span>
            </div>
          </div>
        )}
      </div>

      {/* Info */}
      {info && <div className="mt-3 text-xs text-gray-500 truncate">{info}</div>}
    </div>
  )
}
