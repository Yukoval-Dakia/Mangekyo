import {useState} from 'react';
import {api} from './api';
import {parseAllowedTools, type McpDraft} from './settings-draft';

export function McpToolPicker({server, disabled, onChange}: {
  server: McpDraft; disabled: boolean; onChange: (patch: Partial<McpDraft>) => void;
}) {
  const [catalog, setCatalog] = useState<{name: string; description: string}[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selected = parseAllowedTools(server.allowedToolsText);
  async function browse() {
    setBusy(true); setError('');
    try {
      const token = server.removeToken ? '' : server.token.trim();
      setCatalog(await api('/settings/mcp-tools', {method: 'POST', body: {
        id: server.id, url: server.url.trim(), ...(token || server.removeToken ? {token} : {}),
      }}));
    } catch { setError('读取失败，请核对服务地址和令牌。'); }
    finally { setBusy(false); }
  }
  return <>
    <button type="button" className="text-button" disabled={disabled || busy || !server.url.trim()} onClick={() => void browse()}>
      {busy ? '正在读取工具…' : '从服务读取工具'}
    </button>
    {error && <p role="alert">{error}</p>}
    {catalog?.length === 0 && <p role="status">服务未提供工具。</p>}
    {catalog?.map(tool => <label className="workbook-check" key={tool.name}>
      <input type="checkbox" checked={selected.includes(tool.name)} disabled={disabled} onChange={event => {
        const next = event.target.checked ? [...selected, tool.name] : selected.filter(name => name !== tool.name);
        onChange({allowedToolsText: next.join(', '), allowedTools: next});
      }} />
      <span>{tool.name}{tool.description && <small> · {tool.description.slice(0, 180)}</small>}</span>
    </label>)}
  </>;
}
