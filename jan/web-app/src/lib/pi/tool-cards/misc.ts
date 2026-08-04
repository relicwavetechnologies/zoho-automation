import { argString } from './invoke-args'
import type { DescriptorTable } from './google/types'

/**
 * Descriptors for the single-tool families — web/research, Canva, and a few of
 * Divo's own capabilities. Two shapes appear here:
 *
 *   - flat single-op tools (web/context search, data processor) have no
 *     operation field, so their descriptor lives under the empty-string key `''`
 *     — the resolver looks it up when no op is present.
 *   - `operation`-keyed tools (Semrush, document RAG) and `op`-keyed ones
 *     (Canva) key on their real enum values.
 */

// Flat: { query, limit } — no op field.
const webSearch: DescriptorTable = {
  '': { verb: { present: 'Searching the web', past: 'Searched the web' }, countNoun: 'result', subject: (a) => argString(a, 'query', 'q') },
}

const contextSearch: DescriptorTable = {
  '': { verb: { present: 'Searching knowledge', past: 'Searched knowledge' }, countNoun: 'result', subject: (a) => argString(a, 'query', 'q', 'text') },
}

// operation: search | readSection | readFull | listFiles
const documentRag: DescriptorTable = {
  search: { verb: { present: 'Searching documents', past: 'Searched documents' }, countNoun: 'passage', subject: (a) => argString(a, 'query', 'q') },
  readSection: { verb: { present: 'Reading section', past: 'Read section' }, subject: (a) => argString(a, 'fileName', 'file', 'section') },
  readFull: { verb: { present: 'Reading document', past: 'Read document' }, subject: (a) => argString(a, 'fileName', 'file') },
  listFiles: { verb: { present: 'Listing documents', past: 'Listed documents' }, countNoun: 'document' },
}

// operation: domain_overview | backlinks_comparison | keyword_position_trend
const semrush: DescriptorTable = {
  domain_overview: { verb: { present: 'Analysing', past: 'Analysed' }, subject: (a) => argString(a, 'domain', 'target') },
  backlinks_comparison: { verb: { present: 'Comparing', past: 'Compared' }, countNoun: 'domain', subject: (a) => argString(a, 'targets', 'target') },
  keyword_position_trend: { verb: { present: 'Checking rank', past: 'Checked rank' }, subject: (a) => argString(a, 'keyword', 'domain') },
}

// Flat: runs a JavaScript transform over fetched data.
const dataProcessor: DescriptorTable = {
  '': { verb: { present: 'Processing data', past: 'Processed data' }, countNoun: 'row' },
}

// op: get_assets | search_designs | get_design | generate_design | export_design | list_folder_items | comment_on_design | ...
const canva: DescriptorTable = {
  search_designs: { countNoun: 'design', subject: (a) => argString(a, 'query') },
  get_design: { verb: { present: 'Opening design', past: 'Read design' }, subject: (a) => argString(a, 'designId', 'title') },
  get_design_content: { verb: { present: 'Reading design', past: 'Read design' }, subject: (a) => argString(a, 'designId') },
  generate_design: { verb: { present: 'Generating design', past: 'Generated design' }, action: 'create', subject: (a) => argString(a, 'query', 'title') },
  create_design_from_candidate: { verb: { present: 'Creating design', past: 'Created design' }, action: 'create', subject: (a) => argString(a, 'title') },
  copy_design: { verb: { present: 'Copying design', past: 'Copied design' }, action: 'create', subject: (a) => argString(a, 'designId') },
  export_design: { verb: { present: 'Exporting design', past: 'Exported design' }, subject: (a) => argString(a, 'designId') },
  resize_design: { verb: { present: 'Resizing design', past: 'Resized design' }, action: 'update', subject: (a) => argString(a, 'designId') },
  get_assets: { countNoun: 'asset' },
  list_folder_items: { countNoun: 'item', subject: (a) => argString(a, 'folderId') },
  search_folders: { countNoun: 'folder', subject: (a) => argString(a, 'query') },
  comment_on_design: { verb: { present: 'Commenting', past: 'Commented' }, action: 'update', subject: (a) => argString(a, 'designId') },
  list_comments: { countNoun: 'comment' },
}

export const MISC_DESCRIPTORS = {
  webSearch,
  contextSearch,
  documentRag,
  semrush,
  dataProcessor,
  canva,
}
