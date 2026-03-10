import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  PanelLeftOpen,
  PanelLeftClose,
  PanelRightOpen,
  PanelRightClose,
  Play,
  Plus,
  RefreshCw,
  Save,
  Square,
  TerminalSquare,
  Trash2,
  X,
} from 'lucide-react'
import { useWorkspace } from '../context/WorkspaceContext'
import { cn } from '../lib/utils'

type WorkspaceDirEntry = {
  name: string
  type: 'directory' | 'file' | 'other'
}

type FileNode = {
  path: string
  name: string
  type: 'directory' | 'file'
}

type ContextMenuState = {
  x: number
  y: number
  node: FileNode
} | null

type OpenFile = {
  path: string
  content: string
  savedContent: string
  loading: boolean
}

const ROOT_PATH = '.'

function normalizePath(parentPath: string, name: string): string {
  if (parentPath === ROOT_PATH) return name
  return `${parentPath}/${name}`
}

function fileLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript'
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript'
    case 'json':
      return 'json'
    case 'md':
      return 'markdown'
    case 'py':
      return 'python'
    case 'css':
      return 'css'
    case 'html':
      return 'html'
    case 'yml':
    case 'yaml':
      return 'yaml'
    case 'sh':
    case 'zsh':
      return 'shell'
    case 'sql':
      return 'sql'
    default:
      return 'plaintext'
  }
}

function displayName(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

export function WorkspaceStudio(): JSX.Element {
  const { currentWorkspace } = useWorkspace()
  const [dirMap, setDirMap] = useState<Record<string, FileNode[]>>({})
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({ [ROOT_PATH]: true })
  const [loadingDirs, setLoadingDirs] = useState<Record<string, boolean>>({})
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null)
  const [panelError, setPanelError] = useState<string | null>(null)
  const [savingPath, setSavingPath] = useState<string | null>(null)
  const [isStudioCollapsed, setIsStudioCollapsed] = useState(false)
  const [studioWidth, setStudioWidth] = useState(620)
  const [treeWidth, setTreeWidth] = useState(252)
  const [isTreeCollapsed, setIsTreeCollapsed] = useState(false)
  const [isTerminalOpen, setIsTerminalOpen] = useState(false)
  const [terminalHeight, setTerminalHeight] = useState(220)
  const [terminalCommand, setTerminalCommand] = useState('')
  const [createIntent, setCreateIntent] = useState<'file' | 'folder' | null>(null)
  const [createPathInput, setCreatePathInput] = useState('')
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null)
  const [terminalSession, setTerminalSession] = useState<{
    executionId: string | null
    command: string
    stdout: string
    stderr: string
    status: 'idle' | 'running' | 'done' | 'failed'
    exitCode?: number | null
    durationMs?: number
    cwd: string
  }>({
    executionId: null,
    command: '',
    stdout: '',
    stderr: '',
    status: 'idle',
    cwd: '',
  })
  const dirMapRef = useRef<Record<string, FileNode[]>>({})
  const openFilesRef = useRef<OpenFile[]>([])
  const lastExpandedTreeWidthRef = useRef(252)
  const studioRef = useRef<HTMLElement | null>(null)
  const resizeModeRef = useRef<'studio' | 'tree' | 'terminal' | null>(null)
  const autosaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const activeFile = useMemo(
    () => openFiles.find((file) => file.path === activeFilePath) ?? null,
    [activeFilePath, openFiles],
  )

  useEffect(() => {
    dirMapRef.current = dirMap
  }, [dirMap])

  useEffect(() => {
    openFilesRef.current = openFiles
  }, [openFiles])

  useEffect(() => {
    const closeContextMenu = (): void => setContextMenu(null)
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setContextMenu(null)
    }

    window.addEventListener('click', closeContextMenu)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('click', closeContextMenu)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [])

  useEffect(() => {
    const handlePointerMove = (event: MouseEvent): void => {
      if (!studioRef.current || !resizeModeRef.current) return

      if (resizeModeRef.current === 'studio') {
        const viewportWidth = window.innerWidth
        const nextWidth = Math.min(1100, Math.max(440, viewportWidth - event.clientX))
        setStudioWidth(nextWidth)
        return
      }

      if (resizeModeRef.current === 'terminal') {
        const bounds = studioRef.current.getBoundingClientRect()
        const nextHeight = Math.min(420, Math.max(140, bounds.bottom - event.clientY))
        setTerminalHeight(nextHeight)
        return
      }

      const bounds = studioRef.current.getBoundingClientRect()
      const nextTreeWidth = Math.min(
        Math.max(170, bounds.width - 280),
        Math.max(170, event.clientX - bounds.left),
      )
      setTreeWidth(nextTreeWidth)
    }

    const handlePointerUp = (): void => {
      if (!resizeModeRef.current) return
      resizeModeRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    window.addEventListener('mousemove', handlePointerMove)
    window.addEventListener('mouseup', handlePointerUp)
    return () => {
      window.removeEventListener('mousemove', handlePointerMove)
      window.removeEventListener('mouseup', handlePointerUp)
    }
  }, [])

  useEffect(() => {
    const unsubscribe = window.desktopAPI.terminal.onEvent(({ executionId, event }) => {
      if (terminalSession.executionId !== executionId) return

      switch (event.type) {
        case 'stdout':
          setTerminalSession((prev) => ({ ...prev, stdout: `${prev.stdout}${String(event.data ?? '')}` }))
          break
        case 'stderr':
          setTerminalSession((prev) => ({ ...prev, stderr: `${prev.stderr}${String(event.data ?? '')}` }))
          break
        case 'error': {
          const raw = event.data as { message?: string; durationMs?: number }
          setTerminalSession((prev) => ({
            ...prev,
            stderr: `${prev.stderr}${raw.message ?? 'Execution failed'}\n`,
            status: 'failed',
            durationMs: raw.durationMs,
          }))
          break
        }
        case 'exit': {
          const raw = event.data as { exitCode?: number | null; durationMs?: number }
          setTerminalSession((prev) => ({
            ...prev,
            status: raw.exitCode === 0 ? 'done' : 'failed',
            exitCode: raw.exitCode ?? null,
            durationMs: raw.durationMs,
          }))
          break
        }
        default:
          break
      }
    })

    return unsubscribe
  }, [terminalSession.executionId])

  const loadDirectory = useCallback(async (dirPath: string, force = false) => {
    if (!currentWorkspace) return
    if (!force && dirMapRef.current[dirPath]) return

    setLoadingDirs((prev) => ({ ...prev, [dirPath]: true }))
    setPanelError(null)

    try {
      const result = await window.desktopAPI.workspace.runAction(currentWorkspace.path, {
        kind: 'list_files',
        path: dirPath,
      })

      if (!result.success) {
        throw new Error(result.error || 'Failed to load directory')
      }

      const payload = (result.data ?? {}) as { items?: WorkspaceDirEntry[] }
      const entries = (payload.items ?? []).reduce<FileNode[]>((acc, item) => {
        if (item.type !== 'directory' && item.type !== 'file') return acc
        acc.push({
          path: normalizePath(dirPath, item.name),
          name: item.name,
          type: item.type,
        })
        return acc
      }, [])
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
          return a.name.localeCompare(b.name)
        })

      setDirMap((prev) => ({ ...prev, [dirPath]: entries }))
    } catch (err) {
      setPanelError(err instanceof Error ? err.message : 'Failed to load workspace files')
    } finally {
      setLoadingDirs((prev) => ({ ...prev, [dirPath]: false }))
    }
  }, [currentWorkspace])

  const openFile = useCallback(async (path: string) => {
    if (!currentWorkspace) return

    setPanelError(null)
    setActiveFilePath(path)

    if (openFiles.some((file) => file.path === path)) {
      return
    }

    setOpenFiles((prev) => [...prev, { path, content: '', savedContent: '', loading: true }])

    try {
      const result = await window.desktopAPI.workspace.runAction(currentWorkspace.path, {
        kind: 'read_file',
        path,
      })

      if (!result.success) {
        throw new Error(result.error || 'Failed to open file')
      }

      const payload = (result.data ?? {}) as { content?: string }
      const content = payload.content ?? ''
      setOpenFiles((prev) =>
        prev.map((file) =>
          file.path === path
            ? { ...file, content, savedContent: content, loading: false }
            : file,
        ),
      )
    } catch (err) {
      setPanelError(err instanceof Error ? err.message : 'Failed to open file')
      setOpenFiles((prev) => prev.filter((file) => file.path !== path))
      setActiveFilePath((prev) => (prev === path ? null : prev))
    }
  }, [currentWorkspace, openFiles])

  const readWorkspaceFile = useCallback(async (path: string): Promise<string | null> => {
    if (!currentWorkspace) return null
    const result = await window.desktopAPI.workspace.runAction(currentWorkspace.path, {
      kind: 'read_file',
      path,
    })
    if (!result.success) {
      setPanelError(result.error || 'Failed to read file')
      return null
    }
    const payload = (result.data ?? {}) as { content?: string }
    return payload.content ?? ''
  }, [currentWorkspace])

  const refreshWorkspace = useCallback(async () => {
    if (!currentWorkspace) return

    setDirMap({})
    setExpandedDirs({ [ROOT_PATH]: true })
    await loadDirectory(ROOT_PATH, true)
  }, [currentWorkspace, loadDirectory])

  const refreshParentDirectory = useCallback(async (path: string) => {
    const parts = path.split('/')
    parts.pop()
    const parentPath = parts.length === 0 ? ROOT_PATH : parts.join('/')
    await loadDirectory(parentPath, true)
  }, [loadDirectory])

  useEffect(() => {
    setDirMap({})
    setExpandedDirs({ [ROOT_PATH]: true })
    setOpenFiles([])
    setActiveFilePath(null)
    setPanelError(null)

    if (currentWorkspace) {
      void loadDirectory(ROOT_PATH, true)
    }
  }, [currentWorkspace, loadDirectory])

  const toggleDirectory = useCallback((path: string) => {
    setExpandedDirs((prev) => {
      const nextExpanded = !prev[path]
      if (nextExpanded) {
        void loadDirectory(path)
      }
      return { ...prev, [path]: nextExpanded }
    })
  }, [loadDirectory])

  const updateActiveFileContent = useCallback((nextContent: string | undefined) => {
    if (!activeFilePath) return
    setOpenFiles((prev) =>
      prev.map((file) =>
        file.path === activeFilePath
          ? { ...file, content: nextContent ?? '' }
          : file,
      ),
    )
  }, [activeFilePath])

  const saveWorkspaceFile = useCallback(async (path: string, content: string) => {
    if (!currentWorkspace) return false

    setSavingPath(path)
    setPanelError(null)

    try {
      const result = await window.desktopAPI.workspace.runAction(currentWorkspace.path, {
        kind: 'write_file',
        path,
        content,
      })

      if (!result.success) {
        throw new Error(result.error || 'Failed to save file')
      }

      setOpenFiles((prev) =>
        prev.map((file) =>
          file.path === path
            ? { ...file, content, savedContent: content }
            : file,
        ),
      )
      await refreshParentDirectory(path)
      return true
    } catch (err) {
      setPanelError(err instanceof Error ? err.message : 'Failed to save file')
      return false
    } finally {
      setSavingPath(null)
    }
  }, [currentWorkspace, refreshParentDirectory])

  const saveActiveFile = useCallback(async () => {
    if (!activeFile) return
    await saveWorkspaceFile(activeFile.path, activeFile.content)
  }, [activeFile, saveWorkspaceFile])

  const closeFile = useCallback((path: string) => {
    setOpenFiles((prev) => {
      const remaining = prev.filter((file) => file.path !== path)
      setActiveFilePath((currentActive) => {
        if (currentActive !== path) return currentActive
        return remaining[remaining.length - 1]?.path ?? null
      })
      return remaining
    })
  }, [])

  const startCreateFile = useCallback(() => {
    setCreateIntent('file')
    setCreatePathInput('notes.txt')
    setContextMenu(null)
    setPanelError(null)
  }, [])

  const startCreateFolder = useCallback(() => {
    setCreateIntent('folder')
    setCreatePathInput('src/new-folder')
    setContextMenu(null)
    setPanelError(null)
  }, [])

  const startCreateAtPath = useCallback((kind: 'file' | 'folder', basePath: string) => {
    const defaultLeaf = kind === 'file' ? 'new-file.txt' : 'new-folder'
    const prefix = basePath === ROOT_PATH ? '' : `${basePath}/`
    setCreateIntent(kind)
    setCreatePathInput(`${prefix}${defaultLeaf}`)
    setContextMenu(null)
    setPanelError(null)
  }, [])

  const cancelCreate = useCallback(() => {
    setCreateIntent(null)
    setCreatePathInput('')
  }, [])

  const submitCreate = useCallback(async () => {
    if (!currentWorkspace || !createIntent) return
    const relativePath = createPathInput.trim()
    if (!relativePath) {
      setPanelError(createIntent === 'file' ? 'Enter a file path.' : 'Enter a folder path.')
      return
    }

    setPanelError(null)

    const result = createIntent === 'file'
      ? await window.desktopAPI.workspace.runAction(currentWorkspace.path, {
        kind: 'write_file',
        path: relativePath,
        content: '',
      })
      : await window.desktopAPI.workspace.runAction(currentWorkspace.path, {
        kind: 'mkdir',
        path: relativePath,
      })

    if (!result.success) {
      setPanelError(result.error || `Failed to create ${createIntent}`)
      return
    }

    cancelCreate()
    await refreshParentDirectory(relativePath)
    if (createIntent === 'file') {
      await openFile(relativePath)
    }
  }, [cancelCreate, createIntent, createPathInput, currentWorkspace, openFile, refreshParentDirectory])

  const deletePath = useCallback(async (path: string, type: 'directory' | 'file') => {
    if (!currentWorkspace) return
    if (!window.confirm(`Delete ${path}?`)) return

    setContextMenu(null)
    setPanelError(null)

    const result = await window.desktopAPI.workspace.runAction(currentWorkspace.path, {
      kind: 'delete_path',
      path,
    })

    if (!result.success) {
      setPanelError(result.error || `Failed to delete ${type}`)
      return
    }

    if (type === 'file') {
      closeFile(path)
    } else {
      setDirMap((prev) => {
        const next = { ...prev }
        Object.keys(next).forEach((key) => {
          if (key === path || key.startsWith(`${path}/`)) {
            delete next[key]
          }
        })
        return next
      })
    }

    await refreshParentDirectory(path)
  }, [closeFile, currentWorkspace, refreshParentDirectory])

  const deleteActiveFile = useCallback(async () => {
    if (!currentWorkspace || !activeFile) return
    await deletePath(activeFile.path, 'file')
  }, [activeFile, currentWorkspace, deletePath])

  const renderTree = useCallback((dirPath: string, depth = 0): JSX.Element[] => {
    const nodes = dirMap[dirPath] ?? []
    const isLoading = loadingDirs[dirPath]
    const rows: JSX.Element[] = []

    for (const node of nodes) {
      if (node.type === 'directory') {
        const expanded = Boolean(expandedDirs[node.path])
        rows.push(
          <div key={node.path}>
            <button
              onContextMenu={(event) => {
                event.preventDefault()
                setContextMenu({ x: event.clientX, y: event.clientY, node })
              }}
              onClick={() => toggleDirectory(node.path)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-[hsl(0,0%,72%)] hover:bg-[hsl(0,0%,10%)]"
              style={{ paddingLeft: 10 + depth * 14 }}
            >
              {expanded ? <ChevronDown size={14} className="shrink-0 text-[hsl(0,0%,40%)]" /> : <ChevronRight size={14} className="shrink-0 text-[hsl(0,0%,40%)]" />}
              {expanded ? <FolderOpen size={14} className="shrink-0 text-[hsl(45,78%,62%)]" /> : <Folder size={14} className="shrink-0 text-[hsl(45,78%,62%)]" />}
              <span className="truncate">{node.name}</span>
            </button>
            {expanded && (
              <div>
                {renderTree(node.path, depth + 1)}
                {loadingDirs[node.path] && (
                  <div
                    className="flex items-center gap-2 px-2 py-1 text-[12px] text-[hsl(0,0%,42%)]"
                    style={{ paddingLeft: 34 + depth * 14 }}
                  >
                    <Loader2 size={12} className="animate-spin" />
                    <span>Loading...</span>
                  </div>
                )}
              </div>
            )}
          </div>,
        )
      } else {
        const isActive = node.path === activeFilePath
        rows.push(
          <button
            key={node.path}
            onContextMenu={(event) => {
              event.preventDefault()
              setContextMenu({ x: event.clientX, y: event.clientY, node })
            }}
            onClick={() => void openFile(node.path)}
            className={cn(
              'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors',
              isActive
                ? 'bg-[hsl(0,0%,12%)] text-[hsl(0,0%,92%)]'
                : 'text-[hsl(0,0%,66%)] hover:bg-[hsl(0,0%,10%)] hover:text-[hsl(0,0%,88%)]',
            )}
            style={{ paddingLeft: 26 + depth * 14 }}
          >
            <FileText size={14} className="shrink-0 text-[hsl(210,15%,58%)]" />
            <span className="truncate">{node.name}</span>
          </button>,
        )
      }
    }

    if (dirPath === ROOT_PATH && isLoading && rows.length === 0) {
      rows.push(
        <div key="loading-root" className="flex items-center gap-2 px-3 py-3 text-[12px] text-[hsl(0,0%,42%)]">
          <Loader2 size={12} className="animate-spin" />
          <span>Loading workspace...</span>
        </div>,
      )
    }

    return rows
  }, [activeFilePath, dirMap, expandedDirs, loadingDirs, openFile, toggleDirectory])

  const hasDirtyActiveFile = activeFile ? activeFile.content !== activeFile.savedContent : false
  const focusEditor = useCallback(() => {
    setStudioWidth((prev) => Math.max(prev, 860))
    setTreeWidth(184)
  }, [])

  const closeStudio = useCallback(() => {
    setIsStudioCollapsed(true)
  }, [])

  const openStudio = useCallback(() => {
    setIsStudioCollapsed(false)
  }, [])

  const collapseTree = useCallback(() => {
    lastExpandedTreeWidthRef.current = treeWidth
    setIsTreeCollapsed(true)
  }, [treeWidth])

  const expandTree = useCallback(() => {
    setIsTreeCollapsed(false)
    setTreeWidth(Math.max(184, lastExpandedTreeWidthRef.current))
  }, [])

  const runTerminalCommand = useCallback(async () => {
    if (!currentWorkspace) return
    const command = terminalCommand.trim()
    if (!command || terminalSession.status === 'running') return

    const executionId = crypto.randomUUID()
    setIsTerminalOpen(true)
    setTerminalSession({
      executionId,
      command,
      stdout: '',
      stderr: '',
      status: 'running',
      cwd: currentWorkspace.path,
    })

    const result = await window.desktopAPI.terminal.exec(executionId, command, currentWorkspace.path)
    if (!result.success) {
      setTerminalSession((prev) => ({
        ...prev,
        status: 'failed',
        stderr: `${prev.stderr}${result.error ?? 'Failed to start terminal command'}\n`,
      }))
    }
  }, [currentWorkspace, terminalCommand, terminalSession.status])

  const stopTerminalCommand = useCallback(async () => {
    if (!terminalSession.executionId || terminalSession.status !== 'running') return
    const result = await window.desktopAPI.terminal.kill(terminalSession.executionId)
    if (!result.success) {
      setPanelError(result.error ?? 'Failed to stop terminal command')
    }
  }, [terminalSession.executionId, terminalSession.status])

  const clearTerminalOutput = useCallback(() => {
    if (terminalSession.status === 'running') return
    setTerminalSession((prev) => ({
      ...prev,
      executionId: null,
      command: '',
      stdout: '',
      stderr: '',
      status: 'idle',
      exitCode: undefined,
      durationMs: undefined,
    }))
  }, [terminalSession.status])

  useEffect(() => {
    if (!activeFile || activeFile.loading || activeFile.content === activeFile.savedContent) {
      if (autosaveTimeoutRef.current) {
        clearTimeout(autosaveTimeoutRef.current)
        autosaveTimeoutRef.current = null
      }
      return
    }

    autosaveTimeoutRef.current = setTimeout(() => {
      void saveWorkspaceFile(activeFile.path, activeFile.content)
    }, 900)

    return () => {
      if (autosaveTimeoutRef.current) {
        clearTimeout(autosaveTimeoutRef.current)
        autosaveTimeoutRef.current = null
      }
    }
  }, [activeFile, saveWorkspaceFile])

  useEffect(() => {
    if (!activeFilePath || !currentWorkspace) return

    const interval = setInterval(() => {
      const liveFile = openFilesRef.current.find((file) => file.path === activeFilePath)
      if (!liveFile || liveFile.loading || liveFile.content !== liveFile.savedContent || savingPath === activeFilePath) {
        return
      }

      void readWorkspaceFile(activeFilePath).then((latestContent) => {
        if (latestContent === null) return
        setOpenFiles((prev) =>
          prev.map((file) =>
            file.path === activeFilePath && file.savedContent !== latestContent
              ? { ...file, content: latestContent, savedContent: latestContent }
              : file,
          ),
        )
      })
    }, 1500)

    return () => clearInterval(interval)
  }, [activeFilePath, currentWorkspace, readWorkspaceFile, savingPath])

  if (isStudioCollapsed) {
    return (
      <aside className="flex w-12 shrink-0 border-l border-[hsl(0,0%,12%)] bg-[linear-gradient(180deg,hsl(0,0%,6%),hsl(0,0%,4%))]">
        <div className="flex w-full flex-col items-center gap-3 px-2 py-3">
          <button
            onClick={openStudio}
            className="rounded-xl border border-[hsl(0,0%,16%)] p-2 text-[hsl(0,0%,62%)] hover:bg-[hsl(0,0%,10%)] hover:text-[hsl(0,0%,88%)]"
            title="Open editor"
          >
            <PanelLeftOpen size={15} />
          </button>
          <div className="text-[10px] uppercase tracking-[0.18em] text-[hsl(0,0%,34%)] [writing-mode:vertical-rl] rotate-180">
            Editor
          </div>
        </div>
      </aside>
    )
  }

  return (
    <aside
      ref={studioRef}
      className="flex shrink-0 border-l border-[hsl(0,0%,12%)] bg-[linear-gradient(180deg,hsl(0,0%,6%),hsl(0,0%,4%))]"
      style={{ width: studioWidth }}
    >
      <div
        onMouseDown={() => {
          resizeModeRef.current = 'studio'
          document.body.style.cursor = 'col-resize'
          document.body.style.userSelect = 'none'
        }}
        className="group relative z-10 w-1 shrink-0 cursor-col-resize bg-transparent"
        title="Resize workspace panel"
      >
        <div className="absolute inset-y-0 left-0 w-px bg-transparent transition-colors group-hover:bg-[hsl(45,84%,58%)]" />
      </div>

      {!isTreeCollapsed && (
        <div className="flex shrink-0 flex-col border-r border-[hsl(0,0%,12%)]" style={{ width: treeWidth }}>
        <div className="flex items-center justify-between border-b border-[hsl(0,0%,12%)] px-4 py-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-[hsl(0,0%,42%)]">Files</div>
            <div className="mt-1 text-sm font-medium text-[hsl(0,0%,88%)]">{currentWorkspace?.name ?? 'Workspace'}</div>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => void refreshWorkspace()} className="rounded-lg p-2 text-[hsl(0,0%,55%)] hover:bg-[hsl(0,0%,10%)] hover:text-[hsl(0,0%,88%)]" title="Refresh">
              <RefreshCw size={14} />
            </button>
            <button onClick={startCreateFolder} className="rounded-lg p-2 text-[hsl(0,0%,55%)] hover:bg-[hsl(0,0%,10%)] hover:text-[hsl(0,0%,88%)]" title="New Folder">
              <Folder size={14} />
            </button>
            <button onClick={startCreateFile} className="rounded-lg p-2 text-[hsl(0,0%,55%)] hover:bg-[hsl(0,0%,10%)] hover:text-[hsl(0,0%,88%)]" title="New File">
              <Plus size={14} />
            </button>
            <button onClick={collapseTree} className="rounded-lg p-2 text-[hsl(0,0%,55%)] hover:bg-[hsl(0,0%,10%)] hover:text-[hsl(0,0%,88%)]" title="Collapse file pane">
              <PanelLeftClose size={14} />
            </button>
            <button onClick={closeStudio} className="rounded-lg p-2 text-[hsl(0,0%,55%)] hover:bg-[hsl(0,0%,10%)] hover:text-[hsl(0,0%,88%)]" title="Close editor">
              <PanelRightClose size={14} />
            </button>
          </div>
        </div>

        {createIntent && (
          <div className="border-b border-[hsl(0,0%,12%)] px-3 py-3">
            <div className="text-[11px] font-medium text-[hsl(0,0%,72%)]">
              {createIntent === 'file' ? 'Create file' : 'Create folder'}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                autoFocus
                value={createPathInput}
                onChange={(event) => setCreatePathInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void submitCreate()
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    cancelCreate()
                  }
                }}
                placeholder={createIntent === 'file' ? 'notes.txt' : 'src/new-folder'}
                className="min-w-0 flex-1 rounded-lg border border-[hsl(0,0%,16%)] bg-[hsl(0,0%,8%)] px-3 py-2 text-[12px] text-[hsl(0,0%,88%)] outline-none placeholder:text-[hsl(0,0%,28%)] focus:border-[hsl(45,84%,58%)]"
              />
              <button
                onClick={() => void submitCreate()}
                className="rounded-lg bg-[hsl(45,86%,58%)] px-3 py-2 text-[11px] font-medium text-[hsl(0,0%,10%)] hover:bg-[hsl(45,86%,63%)]"
              >
                Create
              </button>
              <button
                onClick={cancelCreate}
                className="rounded-lg border border-[hsl(0,0%,16%)] px-3 py-2 text-[11px] text-[hsl(0,0%,62%)] hover:bg-[hsl(0,0%,10%)] hover:text-[hsl(0,0%,88%)]"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
          {panelError && (
            <div className="mx-1 mb-2 rounded-xl border border-[hsl(0,45%,22%)] bg-[hsl(0,34%,11%)] px-3 py-2 text-[12px] text-[hsl(0,62%,74%)]">
              {panelError}
            </div>
          )}
          {renderTree(ROOT_PATH)}
        </div>

        {contextMenu && (
          <div
            className="fixed z-50 min-w-[180px] overflow-hidden rounded-xl border border-[hsl(0,0%,16%)] bg-[hsl(0,0%,7%)] p-1 shadow-[0_20px_50px_rgba(0,0,0,0.45)]"
            style={{
              left: Math.max(12, Math.min(contextMenu.x, window.innerWidth - 196)),
              top: Math.max(12, Math.min(contextMenu.y, window.innerHeight - 164)),
            }}
            onClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {contextMenu.node.type === 'file' && (
              <button
                onClick={() => {
                  void openFile(contextMenu.node.path)
                  setContextMenu(null)
                }}
                className="flex w-full items-center rounded-lg px-3 py-2 text-left text-[12px] text-[hsl(0,0%,82%)] hover:bg-[hsl(0,0%,12%)]"
              >
                Open
              </button>
            )}
            {contextMenu.node.type === 'directory' && (
              <>
                <button
                  onClick={() => startCreateAtPath('file', contextMenu.node.path)}
                  className="flex w-full items-center rounded-lg px-3 py-2 text-left text-[12px] text-[hsl(0,0%,82%)] hover:bg-[hsl(0,0%,12%)]"
                >
                  New file here
                </button>
                <button
                  onClick={() => startCreateAtPath('folder', contextMenu.node.path)}
                  className="flex w-full items-center rounded-lg px-3 py-2 text-left text-[12px] text-[hsl(0,0%,82%)] hover:bg-[hsl(0,0%,12%)]"
                >
                  New folder here
                </button>
              </>
            )}
            <button
              onClick={() => void deletePath(contextMenu.node.path, contextMenu.node.type)}
              className="flex w-full items-center rounded-lg px-3 py-2 text-left text-[12px] text-[hsl(0,62%,74%)] hover:bg-[hsl(0,0%,12%)]"
            >
              Delete
            </button>
          </div>
        )}
        </div>
      )}

      {!isTreeCollapsed && (
        <div
          onMouseDown={() => {
            resizeModeRef.current = 'tree'
            document.body.style.cursor = 'col-resize'
            document.body.style.userSelect = 'none'
          }}
          className="group relative z-10 w-1 shrink-0 cursor-col-resize bg-transparent"
          title="Resize file tree"
        >
          <div className="absolute inset-y-0 left-0 w-px bg-transparent transition-colors group-hover:bg-[hsl(45,84%,58%)]" />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-[49px] items-center gap-1 overflow-x-auto border-b border-[hsl(0,0%,12%)] px-3">
          {openFiles.length === 0 ? (
            <div className="px-2 text-[12px] text-[hsl(0,0%,40%)]">Open a file from the workspace tree</div>
          ) : (
            openFiles.map((file) => {
              const isActive = file.path === activeFilePath
              const isDirty = file.content !== file.savedContent
              return (
                <button
                  key={file.path}
                  onClick={() => setActiveFilePath(file.path)}
                  className={cn(
                    'group flex items-center gap-2 rounded-t-xl border border-b-0 px-3 py-2 text-[12px] transition-colors',
                    isActive
                      ? 'border-[hsl(0,0%,16%)] bg-[hsl(0,0%,10%)] text-[hsl(0,0%,92%)]'
                      : 'border-transparent bg-transparent text-[hsl(0,0%,52%)] hover:bg-[hsl(0,0%,8%)] hover:text-[hsl(0,0%,78%)]',
                  )}
                >
                  <FileCode2 size={13} className="shrink-0" />
                  <span className="max-w-[150px] truncate">{displayName(file.path)}</span>
                  {isDirty && <span className="text-[10px] text-[hsl(45,84%,62%)]">●</span>}
                  <span
                    role="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      closeFile(file.path)
                    }}
                    className="rounded-md p-0.5 text-[hsl(0,0%,40%)] hover:bg-[hsl(0,0%,15%)] hover:text-[hsl(0,0%,82%)]"
                  >
                    <X size={12} />
                  </span>
                </button>
              )
            })
          )}
        </div>

        <div className="flex items-center justify-between border-b border-[hsl(0,0%,12%)] px-4 py-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-[hsl(0,0%,86%)]">
              {activeFile ? activeFile.path : 'No file selected'}
            </div>
            <div className="text-[11px] text-[hsl(0,0%,42%)]">
              {activeFile ? `${fileLanguage(activeFile.path)} file` : 'Select a file from the workspace panel'}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {isTreeCollapsed && (
              <button
                onClick={expandTree}
                className="rounded-xl border border-[hsl(0,0%,16%)] px-3 py-1.5 text-[12px] text-[hsl(0,0%,62%)] hover:bg-[hsl(0,0%,10%)] hover:text-[hsl(0,0%,88%)]"
              >
                <PanelRightOpen size={13} className="mr-1 inline-block" />
                Show files
              </button>
            )}
            <button
              onClick={closeStudio}
              className="rounded-xl border border-[hsl(0,0%,16%)] px-3 py-1.5 text-[12px] text-[hsl(0,0%,62%)] hover:bg-[hsl(0,0%,10%)] hover:text-[hsl(0,0%,88%)]"
            >
              <PanelRightClose size={13} className="mr-1 inline-block" />
              Close editor
            </button>
            <button
              onClick={() => setIsTerminalOpen((prev) => !prev)}
              className="rounded-xl border border-[hsl(0,0%,16%)] px-3 py-1.5 text-[12px] text-[hsl(0,0%,62%)] hover:bg-[hsl(0,0%,10%)] hover:text-[hsl(0,0%,88%)]"
            >
              <TerminalSquare size={13} className="mr-1 inline-block" />
              {isTerminalOpen ? 'Hide terminal' : 'Terminal'}
            </button>
            <button
              onClick={focusEditor}
              className="rounded-xl border border-[hsl(0,0%,16%)] px-3 py-1.5 text-[12px] text-[hsl(0,0%,62%)] hover:bg-[hsl(0,0%,10%)] hover:text-[hsl(0,0%,88%)]"
            >
              <PanelLeftClose size={13} className="mr-1 inline-block" />
              Focus editor
            </button>
            {activeFile && (
              <button
                onClick={() => void deleteActiveFile()}
                className="rounded-xl border border-[hsl(0,0%,16%)] px-3 py-1.5 text-[12px] text-[hsl(0,0%,62%)] hover:bg-[hsl(0,0%,10%)] hover:text-[hsl(0,0%,88%)]"
              >
                <Trash2 size={13} className="mr-1 inline-block" />
                Delete
              </button>
            )}
            <button
              onClick={() => void saveActiveFile()}
              disabled={!activeFile || !hasDirtyActiveFile || savingPath === activeFile.path}
              className={cn(
                'rounded-xl px-3 py-1.5 text-[12px] font-medium transition-colors',
                !activeFile || !hasDirtyActiveFile
                  ? 'cursor-not-allowed bg-[hsl(0,0%,10%)] text-[hsl(0,0%,35%)]'
                  : 'bg-[hsl(45,86%,58%)] text-[hsl(0,0%,10%)] hover:bg-[hsl(45,86%,63%)]',
              )}
            >
              {savingPath === activeFile?.path ? <Loader2 size={13} className="mr-1 inline-block animate-spin" /> : <Save size={13} className="mr-1 inline-block" />}
              Save
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col bg-[hsl(0,0%,5%)]">
          <div className="min-h-0 flex-1">
            {activeFile ? (
              activeFile.loading ? (
                <div className="flex h-full items-center justify-center text-[hsl(0,0%,42%)]">
                  <div className="flex items-center gap-2 text-sm">
                    <Loader2 size={14} className="animate-spin" />
                    <span>Opening {displayName(activeFile.path)}...</span>
                  </div>
                </div>
              ) : (
                <Editor
                  path={activeFile.path}
                  language={fileLanguage(activeFile.path)}
                  theme="vs-dark"
                  value={activeFile.content}
                  onChange={updateActiveFileContent}
                  options={{
                    minimap: { enabled: false },
                    fontSize: 13,
                    smoothScrolling: true,
                    wordWrap: 'on',
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    padding: { top: 16, bottom: 16 },
                  }}
                />
              )
            ) : (
              <div className="flex h-full items-center justify-center px-8 text-center">
                <div>
                  <div className="text-sm font-medium text-[hsl(0,0%,72%)]">Workspace editor</div>
                  <div className="mt-2 text-[13px] leading-6 text-[hsl(0,0%,42%)]">
                    Open a file from the tree to inspect or edit it directly. New files and folders can be created from the top of this panel.
                  </div>
                </div>
              </div>
            )}
          </div>

          {isTerminalOpen && (
            <>
              <div
                onMouseDown={() => {
                  resizeModeRef.current = 'terminal'
                  document.body.style.cursor = 'row-resize'
                  document.body.style.userSelect = 'none'
                }}
                className="group relative h-1.5 shrink-0 cursor-row-resize bg-transparent"
                title="Resize terminal"
              >
                <div className="absolute inset-x-0 top-0 h-px bg-transparent transition-colors group-hover:bg-[hsl(45,84%,58%)]" />
              </div>

              <div className="border-t border-[hsl(0,0%,12%)] bg-[hsl(0,0%,4%)]" style={{ height: terminalHeight }}>
                <div className="flex items-center justify-between border-b border-[hsl(0,0%,12%)] px-4 py-2">
                  <div>
                    <div className="text-[12px] font-medium text-[hsl(0,0%,78%)]">Terminal</div>
                    <div className="text-[11px] text-[hsl(0,0%,42%)]">{currentWorkspace?.path ?? ''}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => void clearTerminalOutput()}
                      className="rounded-lg border border-[hsl(0,0%,16%)] px-2.5 py-1 text-[11px] text-[hsl(0,0%,62%)] hover:bg-[hsl(0,0%,10%)] hover:text-[hsl(0,0%,88%)]"
                    >
                      Clear
                    </button>
                    {terminalSession.status === 'running' ? (
                      <button
                        onClick={() => void stopTerminalCommand()}
                        className="rounded-lg border border-[hsl(0,0%,16%)] px-2.5 py-1 text-[11px] text-[hsl(0,0%,62%)] hover:bg-[hsl(0,0%,10%)] hover:text-[hsl(0,0%,88%)]"
                      >
                        <Square size={11} className="mr-1 inline-block" />
                        Stop
                      </button>
                    ) : (
                      <button
                        onClick={() => void runTerminalCommand()}
                        className="rounded-lg bg-[hsl(45,86%,58%)] px-2.5 py-1 text-[11px] font-medium text-[hsl(0,0%,10%)] hover:bg-[hsl(45,86%,63%)]"
                      >
                        <Play size={11} className="mr-1 inline-block" />
                        Run
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 border-b border-[hsl(0,0%,12%)] px-4 py-2">
                  <span className="font-mono text-[12px] text-[hsl(0,0%,46%)]">$</span>
                  <input
                    value={terminalCommand}
                    onChange={(event) => setTerminalCommand(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void runTerminalCommand()
                      }
                    }}
                    placeholder="Run a workspace command"
                    className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-[hsl(0,0%,86%)] outline-none placeholder:text-[hsl(0,0%,28%)]"
                  />
                </div>

                <div className="h-[calc(100%-78px)] overflow-y-auto px-4 py-3 font-mono text-[12px] leading-6 text-[hsl(0,0%,74%)]">
                  {terminalSession.command && (
                    <div className="mb-3 text-[hsl(0,0%,88%)]">$ {terminalSession.command}</div>
                  )}
                  {terminalSession.stdout && (
                    <pre className="mb-3 whitespace-pre-wrap break-words">{terminalSession.stdout}</pre>
                  )}
                  {terminalSession.stderr && (
                    <pre className="mb-3 whitespace-pre-wrap break-words text-[hsl(0,62%,74%)]">{terminalSession.stderr}</pre>
                  )}
                  {!terminalSession.stdout && !terminalSession.stderr && (
                    <div className="text-[hsl(0,0%,38%)]">
                      {terminalSession.status === 'running' ? 'Waiting for output...' : 'No terminal output yet.'}
                    </div>
                  )}
                  {terminalSession.status !== 'idle' && (
                    <div className="mt-4 border-t border-[hsl(0,0%,12%)] pt-3 text-[11px] text-[hsl(0,0%,40%)]">
                      {terminalSession.status === 'running'
                        ? 'Running...'
                        : `Exit code ${terminalSession.exitCode ?? 'unknown'}${terminalSession.durationMs ? ` in ${Math.max(1, Math.round(terminalSession.durationMs / 1000))}s` : ''}`}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </aside>
  )
}
