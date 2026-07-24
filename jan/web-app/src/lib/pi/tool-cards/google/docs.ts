import { argString } from '../invoke-args'
import type { DescriptorTable } from './types'

function docSubject(a: Record<string, unknown>): string | undefined {
  const title = argString(a, 'title', 'name')
  if (title) return title
  const id = argString(a, 'document_id', 'documentId', 'doc_id')
  return id ? `doc …${id.slice(-6)}` : undefined
}

export const DOCS_DESCRIPTORS: DescriptorTable = {
  get_doc_content: {
    verb: { present: 'Opening', past: 'Read' },
    subject: docSubject,
  },
  get_doc_as_markdown: {
    verb: { present: 'Opening', past: 'Read' },
    subject: docSubject,
  },
  create_doc: {
    verb: { present: 'Creating doc', past: 'Created doc' },
    action: 'create',
    subject: (a) => argString(a, 'title', 'name'),
  },
  modify_doc_text: {
    verb: { present: 'Editing', past: 'Edited' },
    action: 'update',
    subject: docSubject,
  },
  find_and_replace_doc: {
    verb: { present: 'Replacing text in', past: 'Replaced text in' },
    action: 'update',
    subject: (a) => {
      const find = argString(a, 'find_text', 'find')
      return find ? `“${find}”` : docSubject(a)
    },
  },
  insert_doc_elements: {
    verb: { present: 'Editing', past: 'Edited' },
    action: 'update',
    subject: docSubject,
  },
  search_docs: {
    subject: (a) => argString(a, 'query', 'q'),
    countNoun: 'doc',
  },
  list_docs_in_folder: {
    verb: { present: 'Listing docs', past: 'Listed docs' },
    subject: (a) => argString(a, 'folder_name', 'folder_id', 'folderId'),
    countNoun: 'doc',
  },
  export_doc_to_pdf: {
    verb: { present: 'Exporting', past: 'Exported to PDF' },
    subject: docSubject,
  },
}
