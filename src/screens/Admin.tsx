import { useRef, useState, useEffect } from 'react'
import {
  getCurrentUserId,
  uploadAndCreateCasesAndAssign,
  UploadProgress,
  ReviewMode,
  setReviewMode as apiSetReviewMode,
  getEscalatedCounts,
  EscalatedCounts,
  getUserRole,
} from '../api'
import type { Screen } from '../App'

interface Props {
  navigate: (screen: Screen) => void
  reviewMode: ReviewMode
  onReviewModeChange: (mode: ReviewMode) => void
}

export default function Admin({ navigate, reviewMode, onReviewModeChange }: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<UploadProgress[]>([])
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  const [isAdmin, setIsAdmin] = useState(false)
  const [counts, setCounts] = useState<EscalatedCounts | null>(null)
  const [settingMode, setSettingMode] = useState(false)
  const [modeError, setModeError] = useState('')

  useEffect(() => {
    getUserRole().then(role => setIsAdmin(role === 'admin'))
    getEscalatedCounts().then(setCounts).catch(() => {})
  }, [])

  async function handleModeChange(mode: ReviewMode) {
    setSettingMode(true)
    setModeError('')
    try {
      await apiSetReviewMode(mode)
      onReviewModeChange(mode)
    } catch (err) {
      setModeError(err instanceof Error ? err.message : String(err))
    } finally {
      setSettingMode(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const files = Array.from(fileRef.current?.files ?? [])
    if (files.length === 0) return

    setError('')
    setDone(false)
    setUploading(true)

    try {
      const uid = await getCurrentUserId()
      await uploadAndCreateCasesAndAssign(files, uid, setProgress)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setUploading(false)
      setDone(true)
    }
  }

  const inserted = progress.filter(p => p.status === 'inserted').length
  const total = progress.length

  function statusLabel(p: UploadProgress) {
    if (p.status === 'uploading') return <span className="status-uploading">Uploading…</span>
    if (p.status === 'inserted') return <span className="status-inserted">Done</span>
    return <span className="status-error" title={p.error}>Error: {p.error}</span>
  }

  const totalPending = counts ? counts.disputed + counts.escalated : null

  return (
    <div>
      <div className="nav">
        <h1>Admin — Upload cases</h1>
        <button className="btn-secondary" onClick={() => navigate('queue')}>
          Back to queue
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {/* Review mode settings — admin only */}
      {isAdmin && (
        <div className="card">
          <h2 style={{ marginBottom: '0.75rem' }}>Review mode</h2>
          <p style={{ fontSize: '0.875rem', color: '#6b7280', marginBottom: '0.75rem' }}>
            Controls how label disagreements are handled after 2 experts label the same case.
          </p>
          <div style={{ display: 'flex', gap: '1.5rem', marginBottom: '0.5rem' }}>
            {(['triage', 'dual'] as ReviewMode[]).map(mode => (
              <label key={mode} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="review_mode"
                  value={mode}
                  checked={reviewMode === mode}
                  disabled={settingMode}
                  onChange={() => handleModeChange(mode)}
                />
                <span>
                  <strong>{mode === 'triage' ? 'Triage' : 'Dual'}</strong>
                  {' — '}
                  {mode === 'triage'
                    ? 'auto-assign a 3rd expert on mismatch'
                    : 'escalate for manual review, no 3rd assignment'}
                </span>
              </label>
            ))}
          </div>
          {modeError && <div className="error" style={{ marginTop: '0.5rem' }}>{modeError}</div>}
        </div>
      )}

      {/* Escalated / disputed counts */}
      <div className="card">
        <h2 style={{ marginBottom: '0.75rem' }}>Resolution queue</h2>
        {counts === null ? (
          <div className="loading" style={{ fontSize: '0.875rem' }}>Loading…</div>
        ) : totalPending === 0 ? (
          <p style={{ fontSize: '0.875rem', color: '#6b7280' }}>No cases awaiting resolution.</p>
        ) : (
          <div style={{ display: 'flex', gap: '2rem' }}>
            {counts.disputed > 0 && (
              <div>
                <div className="queue-stat" style={{ fontSize: '1.75rem' }}>{counts.disputed}</div>
                <p style={{ fontSize: '0.8rem', color: '#6b7280' }}>disputed (triage pending)</p>
              </div>
            )}
            {counts.escalated > 0 && (
              <div>
                <div className="queue-stat" style={{ fontSize: '1.75rem' }}>{counts.escalated}</div>
                <p style={{ fontSize: '0.8rem', color: '#6b7280' }}>escalated (dual mode)</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Upload form */}
      <div className="card">
        <form onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="files">Audiogram images (JPG / PNG)</label>
            <input
              id="files"
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png"
              multiple
              required
            />
          </div>
          <div className="btn-row">
            <button type="submit" className="btn-primary" disabled={uploading}>
              {uploading ? 'Uploading…' : 'Upload'}
            </button>
          </div>
        </form>
      </div>

      {progress.length > 0 && (
        <div className="card">
          {done && (
            <p style={{ marginBottom: '0.75rem', fontWeight: 500 }}>
              {inserted} of {total} uploaded successfully.
            </p>
          )}
          <ul className="upload-list">
            {progress.map(p => (
              <li key={p.filename}>
                <span style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{p.filename}</span>
                {statusLabel(p)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
