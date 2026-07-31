import { argString } from '../invoke-args'
import type { DescriptorTable } from './types'

function fileSubject(a: Record<string, unknown>): string | undefined {
  const name = argString(a, 'file_name', 'name', 'title')
  if (name) return name
  const id = argString(a, 'file_id', 'fileId')
  return id ? `file …${id.slice(-6)}` : undefined
}

export const DRIVE_DESCRIPTORS: DescriptorTable = {
  search_drive_files: {
    subject: (a) => argString(a, 'query', 'q', 'name'),
    countNoun: 'file',
  },
  list_drive_items: {
    verb: { present: 'Listing', past: 'Listed' },
    subject: (a) => argString(a, 'folder_name', 'folder_id', 'folderId'),
    countNoun: 'file',
  },
  get_drive_file_content: {
    verb: { present: 'Opening', past: 'Read' },
    subject: fileSubject,
  },
  create_drive_file: {
    verb: { present: 'Creating file', past: 'Created file' },
    action: 'create',
    subject: fileSubject,
  },
  create_drive_folder: {
    verb: { present: 'Creating folder', past: 'Created folder' },
    action: 'create',
    subject: (a) => argString(a, 'folder_name', 'name', 'title'),
  },
  copy_drive_file: {
    verb: { present: 'Copying', past: 'Copied' },
    action: 'create',
    subject: fileSubject,
  },
  update_drive_file: {
    verb: { present: 'Updating', past: 'Updated' },
    action: 'update',
    subject: fileSubject,
  },
  get_drive_shareable_link: {
    verb: { present: 'Getting link', past: 'Shared link for' },
    subject: fileSubject,
  },
  manage_drive_access: {
    verb: { present: 'Updating access', past: 'Updated access' },
    action: 'update',
    subject: fileSubject,
  },
}
