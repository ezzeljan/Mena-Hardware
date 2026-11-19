import { supabase } from '@/lib/supabase'

export async function deleteProjectWithStorage(projectId: string): Promise<void> {
  const { data: uploads } = await supabase
    .from('quotation_uploads')
    .select('storage_path')
    .eq('project_id', projectId)

  const paths = (uploads ?? [])
    .map((u) => (u as { storage_path: string }).storage_path)
    .filter(Boolean)

  if (paths.length > 0) {
    const { error: storageErr } = await supabase.storage
      .from('quotations')
      .remove(paths)
    if (storageErr) throw storageErr
  }

  const { error: deleteErr } = await supabase
    .from('projects')
    .delete()
    .eq('id', projectId)
  if (deleteErr) throw deleteErr
}
