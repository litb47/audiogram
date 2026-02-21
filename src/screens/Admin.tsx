import { useRef, useState, useEffect } from 'react'
import {
  uploadAndAutoAssign,
  UploadProgress,
  ReviewMode,
  ExpertProfile,
  ExpertStat,
  ResolutionStat,
  setReviewMode as apiSetReviewMode,
  getExpertProfiles,
  getExpertStats,
  getResolutionStats,
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
  const [uploadError, setUploadError] = useState('')
  const [done, setDone] = useState(false)

  const [isAdmin, setIsAdmin] = useState(false)
  const [experts, setExperts] = useState<ExpertProfile[]>([])
  const [expertStats, setExpertStats] = useState<ExpertStat[]>([])
  const [resolutionStats, setResolutionStats] = useState<ResolutionStat[]>([])
  const [statsLoading, setStatsLoading] = useState(true)
  const [settingMode, setSettingMode] = useState(false)
  const [modeError, setModeError] = useState('')

  useEffect(() => {
    async function load() {
      const [role, profiles] = await Promise.all([
        getUserRole(),
        getExpertProfiles().catch(() => [] as ExpertProfile[]),
      ])
      setIsAdmin(role === 'admin')
      setExperts(profiles)

      // Load stats (may fail if case_resolution doesn't exist yet)
      const [stats, res] = await Promise.allSettled([getExpertStats(), getResolutionStats()])
      if (stats.status === 'fulfilled') setExpertStats(stats.value)
      if (res.status === 'fulfilled') setResolutionStats(res.value)
      setStatsLoading(false)
    }
    load()
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

    setUploadError('')
    setDone(false)
    setUploading(true)

    try {
      await uploadAndAutoAssign(files, setProgress)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err))
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

  const agreed    = resolutionStats.find(r => r.status === 'agreed')?.cnt    ?? 0
  const disputed  = resolutionStats.find(r => r.status === 'disputed')?.cnt  ?? 0
  const escalated = resolutionStats.find(r => r.status === 'escalated')?.cnt ?? 0
  const resolved  = resolutionStats.find(r => r.status === 'resolved')?.cnt  ?? 0

  return (
    <div>
      <div className="nav">
        <h1>Admin</h1>
        <button className="btn-secondary" onClick={() => navigate('queue')}>
          Back to queue
        </button>
      </div>

      {/* ── Review mode toggle (admin only) ──────────────────── */}
      {isAdmin && (
        <div className="card">
          <h2 style={{ marginBottom: '0.75rem' }}>Review mode</h2>
          <p style={{ fontSize: '0.875rem', color: '#6b7280', marginBottom: '0.75rem' }}>
            Controls how label disagreements are handled after 2 experts label the same case.
          </p>
          <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
            {(['triage', 'dual'] as ReviewMode[]).map(mode => (
              <label key={mode} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.4rem', cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="review_mode"
                  value={mode}
                  checked={reviewMode === mode}
                  disabled={settingMode}
                  onChange={() => handleModeChange(mode)}
                  style={{ marginTop: '0.2rem' }}
                />
                <span>
                  <strong>{mode === 'triage' ? 'Triage' : 'Dual'}</strong>
                  <span style={{ color: '#6b7280', fontSize: '0.875rem' }}>
                    {' — '}
                    {mode === 'triage'
                      ? 'auto-assign a 3rd expert on mismatch'
                      : 'escalate for manual review (no 3rd assignment)'}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {modeError && <div className="error" style={{ marginTop: '0.5rem' }}>{modeError}</div>}
        </div>
      )}

      {/* ── Resolution stats ─────────────────────────────────── */}
      <div className="card">
        <h2 style={{ marginBottom: '0.75rem' }}>Resolution stats</h2>
        {statsLoading ? (
          <div className="loading" style={{ fontSize: '0.875rem' }}>Loading…</div>
        ) : (
          <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
            {[
              { label: 'agreed',    count: agreed,    color: '#16a34a' },
              { label: 'disputed',  count: disputed,  color: '#d97706' },
              { label: 'escalated', count: escalated, color: '#dc2626' },
              { label: 'resolved',  count: resolved,  color: '#6b7280' },
            ].map(({ label, count, color }) => (
              <div key={label}>
                <div className="queue-stat" style={{ fontSize: '1.75rem', color }}>{count}</div>
                <p style={{ fontSize: '0.8rem', color: '#6b7280' }}>{label}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Per-expert progress ───────────────────────────────── */}
      {expertStats.length > 0 && (
        <div className="card">
          <h2 style={{ marginBottom: '0.75rem' }}>Expert progress</h2>
          <table style={{ width: '100%', fontSize: '0.875rem', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>
                <th style={{ padding: '0.4rem 0.75rem 0.4rem 0', fontWeight: 600 }}>Expert</th>
                <th style={{ padding: '0.4rem 0.75rem', fontWeight: 600, textAlign: 'right' }}>Assigned</th>
                <th style={{ padding: '0.4rem 0.75rem', fontWeight: 600, textAlign: 'right' }}>Labeled</th>
                <th style={{ padding: '0.4rem 0.75rem', fontWeight: 600, textAlign: 'right' }}>Remaining</th>
              </tr>
            </thead>
            <tbody>
              {expertStats.map(s => (
                <tr key={s.expert_user_id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '0.4rem 0.75rem 0.4rem 0', fontFamily: 'monospace', fontSize: '0.78rem', color: '#6b7280' }}>
                    {s.expert_user_id.slice(0, 8)}…
                  </td>
                  <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right' }}>{s.assigned_count}</td>
                  <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right' }}>{s.labeled_count}</td>
                  <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right', fontWeight: s.remaining_count > 0 ? 600 : undefined }}>
                    {s.remaining_count}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Upload form ───────────────────────────────────────── */}
      <div className="card">
        <h2 style={{ marginBottom: '0.75rem' }}>Upload cases</h2>

        {/* Expert pool info */}
        {experts.length >= 2 ? (
          <p style={{ fontSize: '0.875rem', color: '#6b7280', marginBottom: '0.75rem' }}>
            Each case will be auto-assigned to 2 random experts from the pool of {experts.length}.
          </p>
        ) : (
          <p style={{ fontSize: '0.875rem', color: '#dc2626', marginBottom: '0.75rem' }}>
            Need at least 2 experts in <code>public.profiles</code> before uploading (currently {experts.length}).
          </p>
        )}

        {uploadError && <div className="error">{uploadError}</div>}

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
            <button
              type="submit"
              className="btn-primary"
              disabled={uploading || experts.length < 2}
            >
              {uploading ? 'Uploading…' : 'Upload & auto-assign'}
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
