import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { getQueueCount, getUpcomingCases, UpcomingCase } from '../api'
import type { Screen } from '../App'

interface Props {
  navigate: (screen: Screen) => void
}

export default function Queue({ navigate }: Props) {
  const [count, setCount] = useState<number | null>(null)
  const [upcoming, setUpcoming] = useState<UpcomingCase[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([getQueueCount(), getUpcomingCases(10)])
      .then(([c, u]) => {
        setCount(c)
        setUpcoming(u)
      })
      .catch(err => setError(err.message ?? String(err)))
      .finally(() => setLoading(false))
  }, [])

  async function handleLogout() {
    await supabase.auth.signOut()
  }

  function filename(path: string) {
    return path.split('/').pop() ?? path
  }

  return (
    <div>
      <div className="nav">
        <h1>Queue</h1>
        <div className="btn-row" style={{ marginTop: 0 }}>
          <button className="btn-secondary" onClick={() => navigate('admin')}>
            Admin
          </button>
          <button className="btn-danger" onClick={handleLogout}>
            Log out
          </button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <div className="loading">Loading queue…</div>
      ) : (
        <>
          <div className="card">
            <div className="queue-stat">{count ?? '—'}</div>
            <p style={{ color: '#6b7280', fontSize: '0.875rem', marginTop: '0.25rem' }}>
              cases remaining
            </p>
            <div className="btn-row">
              <button
                className="btn-primary"
                disabled={count === 0}
                onClick={() => navigate('case')}
              >
                {count === 0 ? 'All done' : 'Start labeling'}
              </button>
            </div>
          </div>

          {upcoming.length > 0 && (
            <div className="card">
              <h2>Up next</h2>
              <ul className="queue-list">
                {upcoming.map(c => (
                  <li key={c.id}>{filename(c.image_path)}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  )
}
