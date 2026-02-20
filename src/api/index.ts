import { supabase } from '../lib/supabase'

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
