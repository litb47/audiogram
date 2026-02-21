import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import { getReviewMode, ReviewMode } from './api'
import Login from './screens/Login'
import Queue from './screens/Queue'
import Case from './screens/Case'
import Admin from './screens/Admin'

export type Screen = 'login' | 'queue' | 'case' | 'admin'

export default function App() {
  const [screen, setScreen] = useState<Screen>('login')
  const [loading, setLoading] = useState(true)
  const [reviewMode, setReviewMode] = useState<ReviewMode>('triage')

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        setScreen('queue')
        getReviewMode().then(setReviewMode).catch(() => {})
      }
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, session) => {
      if (!session) setScreen('login')
    })

    return () => subscription.unsubscribe()
  }, [])

  if (loading) return <div className="loading">Loading…</div>

  switch (screen) {
    case 'login': return <Login onSuccess={() => setScreen('queue')} />
    case 'queue': return <Queue navigate={setScreen} />
    case 'case':  return <Case navigate={setScreen} />
    case 'admin': return (
      <Admin
        navigate={setScreen}
        reviewMode={reviewMode}
        onReviewModeChange={setReviewMode}
      />
    )
  }
}
