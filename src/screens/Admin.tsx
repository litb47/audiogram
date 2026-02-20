import { useRef, useState } from 'react'
import { getCurrentUserId, uploadAndCreateCasesAndAssign, UploadProgress } from '../api'
import type { Screen } from '../App'

interface Props {
  navigate: (screen: Screen) => void
}

export default function Admin({ navigate }: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<UploadProgress[]>([])
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

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

  return (
    <div>
      <div className="nav">
        <h1>Admin — Upload cases</h1>
        <button className="btn-secondary" onClick={() => navigate('queue')}>
          Back to queue
        </button>
      </div>

      {error && <div className="error">{error}</div>}

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
