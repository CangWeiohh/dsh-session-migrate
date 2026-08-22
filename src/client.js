window.__ModuleLoader__.load({
  id: 'dsh-session-migrate',
  factory: (require) => {
    const React = require('react')
    const { IconBranchOutline16, Modal } = require('@deepseek-ai/dsh-client-ui-primitives')
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    if (typeof document !== 'undefined' && !document.getElementById('dsh-session-migrate-modal-css')) {
      const style = document.createElement('style')
      style.id = 'dsh-session-migrate-modal-css'
      style.textContent = '.dsh-session-migrate-dialog-scroll{max-height:min(72vh,640px)!important}.dsh-session-migrate-result-dialog{width:min(1120px,calc(100vw - 48px))!important}.dsh-session-migrate-content-scroll{min-height:0;overflow-y:auto}'
      document.head.appendChild(style)
    }
    const NS = 'session-migrate'
    const LIST = '/__dsh/session-migrate/list'
    const PLAN = '/__dsh/session-migrate/plan'
    function workspaceLabel(cwd) { if (!cwd) return ''; const base = cwd.replace(/[\\/\\\\]+$/, '').split(/[\\/\\\\]/).pop(); return base || '' }
    const zh = {
      'header': '迁移会话', 'sidebar': '会话迁移', 'title': '准备离线迁移',
      'description': '这里只生成迁移计划。请复制命令，完全退出 DSH Desktop 后再在终端执行。',
      'loading': '正在读取会话和工作区…', 'session': '会话', 'target': '目标工作区',
      'chooseSession': '请选择会话', 'chooseTarget': '请选择目标工作区', 'cancel': '取消',
      'create': '生成迁移计划', 'creating': '正在生成…',
      'tree': '将同时迁移该会话的全部子代理会话。', 'noTargets': '没有其他工作区。',
      'result': '迁移计划已生成', 'steps': '先完全退出 DSH，再执行预检；预检成功后执行正式命令。执行成功后，输出中会返回包含实际备份目录的 cleanupCommand。',
      'dryRun': '预检命令', 'execute': '执行命令', 'cleanup': '清理备份命令（把 <backup-dir> 替换为执行输出中的备份目录，确认稳定后再执行）', 'copy': '复制', 'copied': '已复制', 'close': '关闭',
      'error': '操作失败：'
    }
    const en = {
      'header': 'Move session', 'sidebar': 'Session migration', 'title': 'Prepare offline migration',
      'description': 'This only creates a plan. Copy the commands and run them after fully quitting DSH Desktop.',
      'loading': 'Loading sessions and workspaces…', 'session': 'Session', 'target': 'Target workspace',
      'chooseSession': 'Select a session', 'chooseTarget': 'Select a target workspace', 'cancel': 'Cancel',
      'create': 'Create migration plan', 'creating': 'Creating…',
      'tree': 'All descendant subagent sessions will be migrated together.', 'noTargets': 'No other workspace.',
      'result': 'Migration plan created', 'steps': 'Fully quit DSH, run the dry-run, then execute the migration. After a successful execute, its output returns a cleanupCommand with the actual backup dir.',
      'dryRun': 'Dry-run command', 'execute': 'Execute command', 'cleanup': 'Backup cleanup command (replace <backup-dir> with the backup dir from execute output; run after confirming stability)', 'copy': 'Copy', 'copied': 'Copied', 'close': 'Close',
      'error': 'Operation failed: '
    }
    let show = null
    async function json(url, options, signal) {
      const response = await fetch(url, { ...options, signal })
      let value = {}; try { value = await response.json() } catch {}
      if (!response.ok || value.ok === false) { const error = new Error(value?.error?.message || `HTTP ${response.status}`); error.code = value?.error?.code; throw error }
      return value
    }
    function Trigger({ t, sessionId, wide }) {
      const label = sessionId ? t('header') : t('sidebar')
      return React.createElement('button', {
        type: 'button', title: label, 'aria-label': label,
        style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, minWidth: 28, height: 28, padding: wide ? '0 8px' : 0, border: 0, borderRadius: 7, background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' },
        onClick: () => show?.({ sessionId: sessionId || '' }),
      }, React.createElement(IconBranchOutline16, { size: 16 }), wide ? React.createElement('span', null, label) : null)
    }
    function Copy({ t, label, value }) {
      const [copied, setCopied] = useState(false)
      return React.createElement('div', { style: { display: 'grid', gap: 6 } },
        React.createElement('strong', null, label),
        React.createElement('div', { style: { display: 'flex', minWidth: 0, maxWidth: '100%', gap: 8, alignItems: 'flex-start' } },
          React.createElement('code', { style: { flex: 1, minWidth: 0, maxWidth: '100%', padding: 8, borderRadius: 6, background: 'var(--dsw-alias-bg-layer-2)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, value),
          React.createElement('button', { type: 'button', onClick: async () => { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1000) } }, copied ? t('copied') : t('copy'))))
    }
    function Dialog({ t }) {
      const abort = useRef(null)
      const [open, setOpen] = useState(false), [phase, setPhase] = useState('idle')
      const [catalog, setCatalog] = useState({ sessions: [], workspaces: [] })
      const [sessionId, setSessionId] = useState(''), [targetId, setTargetId] = useState('')
      const [error, setError] = useState(null), [result, setResult] = useState(null)
      useEffect(() => {
        show = (detail = {}) => {
          abort.current?.abort(); const controller = new AbortController(); abort.current = controller
          setOpen(true); setPhase('loading'); setSessionId(detail.sessionId || ''); setTargetId(''); setError(null); setResult(null)
          json(LIST, { method: 'GET' }, controller.signal).then((value) => { if (!controller.signal.aborted) { setCatalog(value); setPhase('ready') } }, (reason) => { if (!controller.signal.aborted) { setError(reason); setPhase('error') } })
        }
        return () => { show = null; abort.current?.abort() }
      }, [])
      const selected = useMemo(() => catalog.sessions.find((row) => row.sessionId === sessionId), [catalog.sessions, sessionId])
      const targets = useMemo(() => catalog.workspaces.filter((row) => row.workspaceId !== selected?.workspaceId), [catalog.workspaces, selected])
      const close = useCallback(() => { if (phase === 'creating') return; abort.current?.abort(); setOpen(false) }, [phase])
      const create = useCallback(() => {
        if (!sessionId || !targetId) return
        abort.current?.abort(); const controller = new AbortController(); abort.current = controller; setPhase('creating'); setError(null)
        json(PLAN, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, targetWorkspaceId: targetId }) }, controller.signal)
          .then((value) => { if (!controller.signal.aborted) { setResult(value); setPhase('result') } }, (reason) => { if (!controller.signal.aborted) { setError(reason); setPhase('ready') } })
      }, [sessionId, targetId, selected])
      if (!open) return null
      if (phase === 'result') return React.createElement(Modal, { open: true, onClose: close, closeLabel: t('close'), title: t('result'), description: t('steps'), className: 'dsh-session-migrate-dialog-scroll dsh-session-migrate-result-dialog', contentClassName: 'dsh-session-migrate-content-scroll', footer: React.createElement('button', { onClick: close }, t('close')) },
        React.createElement('div', { style: { width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box', display: 'grid', gap: 14 } }, React.createElement(Copy, { t, label: t('dryRun'), value: result.dryRunCommand }), React.createElement(Copy, { t, label: t('execute'), value: result.command }), result.cleanupCommandTemplate ? React.createElement(Copy, { t, label: t('cleanup'), value: result.cleanupCommandTemplate }) : null))
      const canCreate = phase === 'ready' && Boolean(sessionId) && Boolean(targetId)
      const selectStyle = { boxSizing: 'border-box', width: '100%', maxWidth: '100%', minWidth: 0, height: 36, marginTop: 6, padding: '0 8px', textOverflow: 'ellipsis' }
      return React.createElement(Modal, { open: true, onClose: close, closeLabel: t('cancel'), title: t('title'), description: t('description'), className: 'dsh-session-migrate-dialog-scroll', contentClassName: 'dsh-session-migrate-content-scroll', footer: [React.createElement('button', { key: 'c', disabled: phase === 'creating', onClick: close }, t('cancel')), React.createElement('button', { key: 'p', disabled: !canCreate, onClick: create }, phase === 'creating' ? t('creating') : t('create'))] },
        React.createElement('div', { style: { width: 'min(520px, calc(100vw - 64px))', maxWidth: '100%', minWidth: 0, display: 'grid', gap: 14, overflow: 'hidden' } },
          phase === 'loading' ? React.createElement('p', null, t('loading')) : null,
          phase !== 'loading' ? React.createElement('label', { style: { minWidth: 0, maxWidth: '100%' } }, t('session'), React.createElement('select', { style: selectStyle, value: sessionId, onChange: (e) => { setSessionId(e.currentTarget.value); setTargetId('') } }, React.createElement('option', { value: '' }, t('chooseSession')), catalog.sessions.map((row) => React.createElement('option', { key: row.sessionId, value: row.sessionId }, `${row.title || row.sessionId}${workspaceLabel(row.cwd) ? ' \u2014 ' + workspaceLabel(row.cwd) : ''}`)))) : null,
          selected?.related ? React.createElement('p', { role: 'status' }, t('tree')) : null,
          sessionId ? React.createElement('label', { style: { minWidth: 0, maxWidth: '100%' } }, t('target'), React.createElement('select', { style: selectStyle, value: targetId, disabled: !targets.length, onChange: (e) => setTargetId(e.currentTarget.value) }, React.createElement('option', { value: '' }, targets.length ? t('chooseTarget') : t('noTargets')), targets.map((row) => React.createElement('option', { key: row.workspaceId, value: row.workspaceId }, `${row.title} — ${row.path}`)))) : null,
          error ? React.createElement('p', { role: 'alert' }, `${t('error')}${error.message || String(error)}`) : null))
    }
    const inject = ['slots', 'locale']
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-migrate: dictionaries')
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'session-migrate', order: 100, locale: NS }, Trigger))
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'session-migrate', order: 100, locale: NS }, Trigger))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'session-migrate-dialog', order: 100, locale: NS }, Dialog))
    }
    return { apply, inject }
  },
})
