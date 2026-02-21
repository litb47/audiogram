import { supabase } from '../lib/supabase'

export type ReviewMode = 'dual' | 'triage'

export interface EscalatedCounts {
  disputed: number
  escalated: number
}

export interface ExpertProfile {
  user_id: string
  role: string
}

export interface ExpertStat {
  expert_user_id: string
  assigned_count: number
  labeled_count: number
  remaining_count: number
}

export interface ResolutionStat {
  status: string
  cnt: number
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

// ── Review mode ──────────────────────────────────────────────

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

// ── User / role ──────────────────────────────────────────────

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

export async function getExpertProfiles(): Promise<ExpertProfile[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('user_id, role')
    .eq('role', 'expert')
  if (error) throw error
  return (data ?? []) as ExpertProfile[]
}

// ── Dashboard stats ──────────────────────────────────────────

export async function getEscalatedCounts(): Promise<EscalatedCounts> {
  const [d, e] = await Promise.all([
    supabase.from('case_resolution').select('*', { count: 'exact', head: true }).eq('status', 'disputed'),
    supabase.from('case_resolution').select('*', { count: 'exact', head: true }).eq('status', 'escalated'),
  ])
  return { disputed: d.count ?? 0, escalated: e.count ?? 0 }
}

export async function getExpertStats(): Promise<ExpertStat[]> {
  const { data, error } = await supabase.rpc('get_expert_stats')
  if (error) throw error
  return (data ?? []) as ExpertStat[]
}

export async function getResolutionStats(): Promise<ResolutionStat[]> {
  const { data, error } = await supabase.rpc('get_resolution_stats')
  if (error) throw error
  return (data ?? []) as ResolutionStat[]
}

// ── Upload + assignment ───────────────────────────────────────

// Default upload path: server picks exactly 2 random experts automatically.
// Requires ≥2 profiles with role='expert' in the database.
export async function uploadAndAutoAssign(
  files: File[],
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
      // 1. Upload file to storage (client-side)
      const { error: uploadError } = await supabase.storage
        .from('audiograms')
        .upload(path, file)
      if (uploadError) throw uploadError

      // 2. Create case + pick 2 random experts + create 2 assignments atomically
      const { error: rpcError } = await supabase.rpc(
        'admin_create_case_auto_assign',
        { p_image_path: path }
      )
      if (rpcError) throw rpcError

      statuses[i] = { filename: file.name, status: 'inserted' }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      statuses[i] = { filename: file.name, status: 'error', error: msg }
    }

    onProgress([...statuses])
  }
}

// Manual override: caller supplies the exact expert IDs to assign.
// Used for special cases where the admin wants to control assignment.
export async function uploadAndCreateCasesAndAssign(
  files: File[],
  expertIds: string[],
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
      const { error: uploadError } = await supabase.storage
        .from('audiograms')
        .upload(path, file)
      if (uploadError) throw uploadError

      const { error: rpcError } = await supabase.rpc(
        'admin_create_case_with_assignments',
        { p_image_path: path, p_expert_ids: expertIds }
      )
      if (rpcError) throw rpcError

      statuses[i] = { filename: file.name, status: 'inserted' }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      statuses[i] = { filename: file.name, status: 'error', error: msg }
    }

    onProgress([...statuses])
  }
}
