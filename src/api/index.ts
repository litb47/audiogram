import { supabase } from '../lib/supabase'

export type ReviewMode = 'dual' | 'triage'

export interface EscalatedCounts {
  disputed: number
  escalated: number
}

export interface CaseRow {
  id: string
  image_path: string
  created_at: string
}

export interface UpcomingCase {
  id: string
  image_path: string
}

export interface LabelPayload {
  case_id: string
  expert_user_id: string
  payload: Record<string, unknown>
  confidence: number
  duration_ms: number
}

export interface UploadProgress {
  filename: string
  status: 'uploading' | 'inserted' | 'error'
  error?: string
}

export async function getCurrentUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) throw error ?? new Error('Not authenticated')
  return data.user.id
}

export async function getNextCase(): Promise<CaseRow | null> {
  const { data, error } = await supabase.rpc('get_next_case')
  if (error) throw error
  if (!data || data.length === 0) return null
  return data[0] as CaseRow
}

export async function getQueueCount(): Promise<number> {
  const { data, error } = await supabase.rpc('get_queue_count')
  if (error) throw error
  return Number(data ?? 0)
}

export async function getUpcomingCases(limit: number): Promise<UpcomingCase[]> {
  const { data, error } = await supabase.rpc('get_upcoming_cases', { lim: limit })
  if (error) throw error
  return (data ?? []) as UpcomingCase[]
}

export async function createSignedImageUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from('audiograms')
    .createSignedUrl(path, 3600)
  if (error || !data?.signedUrl) throw error ?? new Error('Failed to create signed URL')
  return data.signedUrl
}

export async function insertLabel(payload: LabelPayload): Promise<void> {
  const { error } = await supabase.from('labels').insert(payload)
  if (error) throw error
}

export async function getReviewMode(): Promise<ReviewMode> {
  const { data, error } = await supabase
    .from('project_settings')
    .select('review_mode')
    .eq('id', 1)
    .single()
  if (error) throw error
  return (data?.review_mode ?? 'triage') as ReviewMode
}

export async function setReviewMode(mode: ReviewMode): Promise<void> {
  const { error } = await supabase
    .from('project_settings')
    .update({ review_mode: mode })
    .eq('id', 1)
  if (error) throw error
}

export async function getEscalatedCounts(): Promise<EscalatedCounts> {
  const [d, e] = await Promise.all([
    supabase.from('case_resolution').select('*', { count: 'exact', head: true }).eq('status', 'disputed'),
    supabase.from('case_resolution').select('*', { count: 'exact', head: true }).eq('status', 'escalated'),
  ])
  return { disputed: d.count ?? 0, escalated: e.count ?? 0 }
}

export async function getUserRole(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data } = await supabase
    .from('profiles')
    .select('role')
    .eq('user_id', user.id)
    .single()
  return data?.role ?? null
}

export async function uploadAndCreateCasesAndAssign(
  files: File[],
  uid: string,
  onProgress: (updates: UploadProgress[]) => void
): Promise<void> {
  const statuses: UploadProgress[] = files.map(f => ({
    filename: f.name,
    status: 'uploading',
  }))
  onProgress([...statuses])

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const path = `cases/${Date.now()}_${file.name}`

    try {
      // 1. Upload file to storage
      const { error: uploadError } = await supabase.storage
        .from('audiograms')
        .upload(path, file)
      if (uploadError) throw uploadError

      // 2. Insert case row
      const { data: caseData, error: caseError } = await supabase
        .from('cases')
        .insert({ image_path: path })
        .select('id')
        .single()
      if (caseError || !caseData) throw caseError ?? new Error('No case returned')

      // 3. Insert assignment row
      const { error: assignError } = await supabase
        .from('assignments')
        .insert({ case_id: caseData.id, expert_user_id: uid })
      if (assignError) throw assignError

      statuses[i] = { filename: file.name, status: 'inserted' }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      statuses[i] = { filename: file.name, status: 'error', error: msg }
    }

    onProgress([...statuses])
  }
}
