import { useState } from 'react'

export interface TerminalSession {
  commandLine: string
  cwd?: string
  defaultLabel: string
  detail: string
  id: string
  kind: 'agent' | 'shell'
  label: string
  pid: number
  runningFor: string
  terminalApp: string
}

interface TerminalSessionsModalProps {
  isOpen: boolean
  onClose: () => void
  onFocusSession: (sessionId: string) => void
  onOpenTerminal: () => void
  onRenameSession: (sessionId: string, label: string) => void
  onTerminateSession: (sessionId: string) => void
  sessions: TerminalSession[]
}

const actionButtonStyle: React.CSSProperties = {
  background: 'var(--pixel-btn-bg)',
  border: '2px solid var(--pixel-border)',
  color: 'var(--pixel-text)',
  cursor: 'pointer',
  fontSize: '18px',
  padding: '4px 8px',
}

export function TerminalSessionsModal({
  isOpen,
  onClose,
  onFocusSession,
  onOpenTerminal,
  onRenameSession,
  onTerminateSession,
  sessions,
}: TerminalSessionsModalProps) {
  const [hovered, setHovered] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftLabel, setDraftLabel] = useState('')

  if (!isOpen) return null

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          background: 'rgba(0, 0, 0, 0.5)',
          zIndex: 59,
        }}
      />
      <div
        style={{
          position: 'fixed',
          right: 16,
          bottom: 72,
          zIndex: 60,
          width: 440,
          maxWidth: 'calc(100vw - 32px)',
          maxHeight: 'calc(100vh - 120px)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--pixel-bg)',
          border: '2px solid var(--pixel-border)',
          boxShadow: 'var(--pixel-shadow)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 10px',
            borderBottom: '2px solid var(--pixel-border)',
          }}
        >
          <div>
            <div style={{ fontSize: '24px', color: 'var(--pixel-text)' }}>Terminal Sessions</div>
            <div style={{ fontSize: '16px', color: 'var(--pixel-text-dim)' }}>
              Detected macOS terminal-backed shells and agents
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={onOpenTerminal}
              style={actionButtonStyle}
              title="Open a new Terminal.app shell"
            >
              + Shell
            </button>
            <button
              onClick={onClose}
              style={actionButtonStyle}
            >
              Close
            </button>
          </div>
        </div>

        <div style={{ overflowY: 'auto', padding: 8 }}>
          {sessions.length === 0 ? (
            <div
              style={{
                padding: 14,
                fontSize: '18px',
                color: 'var(--pixel-text-dim)',
                border: '2px dashed var(--pixel-border)',
              }}
            >
              No terminal sessions detected yet.
            </div>
          ) : (
            sessions.map((session) => {
              const hoverKey = `session:${session.id}`
              const isHovered = hovered === hoverKey
              const isEditing = editingId === session.id
              const hasCustomLabel = session.label !== session.defaultLabel
              return (
                <div
                  key={session.id}
                  onMouseEnter={() => setHovered(hoverKey)}
                  onMouseLeave={() => setHovered(null)}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr auto',
                    gap: 10,
                    padding: '8px 10px',
                    marginBottom: 8,
                    background: isHovered ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.03)',
                    border: '2px solid var(--pixel-border)',
                  }}
                >
                  <div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        marginBottom: 4,
                        flexWrap: 'wrap',
                      }}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          value={draftLabel}
                          placeholder={session.defaultLabel}
                          onChange={(e) => setDraftLabel(e.target.value)}
                          onBlur={() => {
                            onRenameSession(session.id, draftLabel)
                            setEditingId(null)
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              onRenameSession(session.id, draftLabel)
                              setEditingId(null)
                            } else if (e.key === 'Escape') {
                              setEditingId(null)
                            }
                          }}
                          style={{
                            background: 'rgba(255,255,255,0.08)',
                            border: '2px solid var(--pixel-border)',
                            color: 'var(--pixel-text)',
                            fontSize: '19px',
                            minWidth: 140,
                            padding: '2px 6px',
                          }}
                        />
                      ) : (
                        <span style={{ fontSize: '21px', color: 'var(--pixel-text)' }}>{session.label}</span>
                      )}
                      <span
                        style={{
                          fontSize: '14px',
                          color: session.kind === 'agent' ? '#9cd0ff' : 'var(--pixel-text-dim)',
                          border: '1px solid var(--pixel-border)',
                          padding: '1px 5px',
                        }}
                      >
                        {session.kind}
                      </span>
                      <span style={{ fontSize: '14px', color: 'var(--pixel-text-dim)' }}>
                        {session.terminalApp}
                      </span>
                      <span style={{ fontSize: '14px', color: 'var(--pixel-text-dim)' }}>
                        {session.runningFor}
                      </span>
                    </div>
                    {session.cwd && (
                      <div
                        style={{
                          fontSize: '14px',
                          color: 'var(--pixel-text-dim)',
                          marginBottom: 3,
                          wordBreak: 'break-word',
                        }}
                      >
                        {session.cwd}
                      </div>
                    )}
                    <div style={{ fontSize: '15px', color: 'var(--pixel-text-dim)', marginBottom: 3 }}>
                      PID {session.pid}
                    </div>
                    {hasCustomLabel && (
                      <div style={{ fontSize: '14px', color: 'var(--pixel-text-dim)', marginBottom: 3 }}>
                        Default name: {session.defaultLabel}
                      </div>
                    )}
                    <div
                      title={session.commandLine}
                      style={{
                        fontSize: '14px',
                        color: 'var(--pixel-text-dim)',
                        wordBreak: 'break-word',
                      }}
                    >
                      {session.detail}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'start' }}>
                    <button
                      onClick={() => {
                        setEditingId(session.id)
                        setDraftLabel(session.label)
                      }}
                      style={actionButtonStyle}
                    >
                      Rename
                    </button>
                    {hasCustomLabel && (
                      <button
                        onClick={() => {
                          onRenameSession(session.id, '')
                          if (editingId === session.id) {
                            setEditingId(null)
                          }
                        }}
                        style={actionButtonStyle}
                      >
                        Reset
                      </button>
                    )}
                    <button
                      onClick={() => onFocusSession(session.id)}
                      style={actionButtonStyle}
                    >
                      Focus
                    </button>
                    <button
                      onClick={() => onTerminateSession(session.id)}
                      style={{
                        ...actionButtonStyle,
                        color: '#ffb2b2',
                      }}
                    >
                      End
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </>
  )
}
