import { useEffect, useRef, useState } from 'react'
import { getNextCase, createSignedImageUrl, insertLabel, getCurrentUserId, CaseRow } from '../api'
import type { Screen } from '../App'

interface Props {
  navigate: (screen: Screen) => void
}

type LossType = 'normal' | 'conductive' | 'sensorineural' | 'mixed'
type Severity  = 'normal' | 'mild' | 'moderate' | 'moderately-severe' | 'severe' | 'profound'
type Pattern   = 'flat' | 'sloping' | 'rising' | 'cookie-bite' | 'notch' | 'n/a'

interface EarForm {
  loss_type: LossType
  severity: Severity
  pattern: Pattern
}

interface FormState {
  right: EarForm
  left: EarForm
  recommendation: 'referral' | 'monitor' | 'none'
  confidence: number
  notes: string
}

const defaultEar: EarForm = { loss_type: 'normal', severity: 'normal', pattern: 'flat' }
const defaultForm: FormState = {
  right: { ...defaultEar },
  left: { ...defaultEar },
  recommendation: 'none',
  confidence: 3,
  notes: '',
}

export default function Case({ navigate }: Props) {
  const [currentCase, setCurrentCase] = useState<CaseRow | null | undefined>(undefined)
  const [signedUrl, setSignedUrl] = useState('')
  const [zoomed, setZoomed] = useState(false)
  const [form, setForm] = useState<FormState>(defaultForm)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const startTime = useRef(Date.now())

  useEffect(() => {
    loadNext()
  }, [])

  async function loadNext() {
    setError('')
    setZoomed(false)
    setForm(defaultForm)
    startTime.current = Date.now()
    try {
      const c = await getNextCase()
      setCurrentCase(c)
      if (c) {
        const url = await createSignedImageUrl(c.image_path)
        setSignedUrl(url)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setCurrentCase(null)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!currentCase) return
    setError('')
    setSubmitting(true)
    try {
      const uid = await getCurrentUserId()
      await insertLabel({
        case_id: currentCase.id,
        expert_user_id: uid,
        payload: {
          right_ear: form.right,
          left_ear: form.left,
          recommendation: form.recommendation,
          notes: form.notes,
        },
        confidence: form.confidence,
        duration_ms: Date.now() - startTime.current,
      })
      // Load next case (labels are source of truth — no cases.status update)
      await loadNext()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  function setEar(ear: 'right' | 'left', field: keyof EarForm, value: string) {
    setForm(f => ({ ...f, [ear]: { ...f[ear], [field]: value } }))
  }

  // Still loading first case
  if (currentCase === undefined) {
    return <div className="loading">Loading case…</div>
  }

  // Queue empty
  if (currentCase === null) {
    return (
      <div>
        <div className="nav">
          <h1>Case</h1>
        </div>
        <div className="card">
          <div className="info">No more cases assigned to you.</div>
          <button className="btn-secondary" onClick={() => navigate('queue')}>
            Back to queue
          </button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="nav">
        <h1>Label case</h1>
        <button className="btn-secondary" onClick={() => navigate('queue')}>
          Back to queue
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      <p style={{ fontSize: '0.8rem', color: '#6b7280', marginBottom: '0.5rem', fontFamily: 'monospace' }}>
        {currentCase.image_path.split('/').pop()}
      </p>

      <div
        className={`image-container${zoomed ? ' zoomed' : ''}`}
        onClick={() => setZoomed(z => !z)}
        title={zoomed ? 'Click to zoom out' : 'Click to zoom in'}
      >
        {signedUrl ? (
          <img src={signedUrl} alt="Audiogram" draggable={false} />
        ) : (
          <div className="loading" style={{ color: '#9ca3af' }}>Loading image…</div>
        )}
      </div>

      <form onSubmit={handleSubmit}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          {(['right', 'left'] as const).map(ear => (
            <fieldset key={ear}>
              <legend>{ear === 'right' ? 'Right ear' : 'Left ear'}</legend>
              <div className="field">
                <label>Loss type</label>
                <select value={form[ear].loss_type} onChange={e => setEar(ear, 'loss_type', e.target.value)}>
                  <option value="normal">Normal</option>
                  <option value="conductive">Conductive</option>
                  <option value="sensorineural">Sensorineural</option>
                  <option value="mixed">Mixed</option>
                </select>
              </div>
              <div className="field">
                <label>Severity</label>
                <select value={form[ear].severity} onChange={e => setEar(ear, 'severity', e.target.value)}>
                  <option value="normal">Normal</option>
                  <option value="mild">Mild</option>
                  <option value="moderate">Moderate</option>
                  <option value="moderately-severe">Moderately severe</option>
                  <option value="severe">Severe</option>
                  <option value="profound">Profound</option>
                </select>
              </div>
              <div className="field">
                <label>Pattern</label>
                <select value={form[ear].pattern} onChange={e => setEar(ear, 'pattern', e.target.value)}>
                  <option value="flat">Flat</option>
                  <option value="sloping">Sloping</option>
                  <option value="rising">Rising</option>
                  <option value="cookie-bite">Cookie-bite</option>
                  <option value="notch">Notch</option>
                  <option value="n/a">N/A</option>
                </select>
              </div>
            </fieldset>
          ))}
        </div>

        <div className="card">
          <div className="field">
            <label>Recommendation</label>
            <select
              value={form.recommendation}
              onChange={e => setForm(f => ({ ...f, recommendation: e.target.value as FormState['recommendation'] }))}
            >
              <option value="none">None</option>
              <option value="monitor">Monitor</option>
              <option value="referral">Referral</option>
            </select>
          </div>

          <div className="field">
            <label>Confidence (1 = low, 5 = high)</label>
            <div className="confidence-row">
              {[1, 2, 3, 4, 5].map(n => (
                <label key={n}>
                  <input
                    type="radio"
                    name="confidence"
                    value={n}
                    checked={form.confidence === n}
                    onChange={() => setForm(f => ({ ...f, confidence: n }))}
                  />
                  {n}
                </label>
              ))}
            </div>
          </div>

          <div className="field">
            <label>Notes</label>
            <textarea
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              placeholder="Optional notes…"
            />
          </div>

          <div className="btn-row">
            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? 'Submitting…' : 'Submit label'}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}
