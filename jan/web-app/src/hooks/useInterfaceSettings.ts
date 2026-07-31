import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import {
  getDefaultNotificationPosition,
  isNotificationPosition,
  type NotificationPosition,
} from '@/utils/toastPlacement'

export type FontSize = '14px' | '15px' | '16px' | '18px' | '20px'

export const ACCENT_COLORS = [
  {
    name: 'Gray',
    value: 'gray',
    thumb: '#3F3F46',
    primary: '#f17455',
  },
  {
    name: 'Red',
    value: 'red',
    thumb: '#F0614B',
    primary: '#F0614B',
  },
  {
    name: 'Orange',
    value: 'orange',
    thumb: '#E9A23F',
    primary: '#E9A23F',
  },
  {
    name: 'Green',
    value: 'green',
    thumb: '#88BA42',
    primary: '#88BA42',
  },
  {
    name: 'Emerald',
    value: 'emerald',
    thumb: '#38AB51',
    primary: '#38AB51',
  },
  {
    name: 'Teal',
    value: 'teal',
    thumb: '#38AB8D',
    primary: '#38AB8D',
  },
  {
    name: 'Cyan',
    value: 'cyan',
    thumb: '#45BBDE',
    primary: '#45BBDE',
  },
  {
    name: 'Blue',
    value: 'blue',
    thumb: '#456BDE',
    primary: '#456BDE',
  },
  {
    name: 'Purple',
    value: 'purple',
    thumb: '#865EEA',
    primary: '#865EEA',
  },
  {
    name: 'Pink',
    value: 'pink',
    thumb: '#D55EF3',
    primary: '#D55EF3',
  },
  {
    name: 'Rose',
    value: 'rose',
    thumb: '#F655B8',
    primary: '#F655B8',
  },
] as const

export type AccentColorValue = (typeof ACCENT_COLORS)[number]['value']
const DEFAULT_ACCENT_COLOR: AccentColorValue = 'gray'

// Accent drives --primary only. The sidebar is a fixed neutral grey owned by
// index.css (light/dark), so it no longer picks up the accent tint.
const applyAccentColorToDOM = (colorValue: string) => {
  const color = ACCENT_COLORS.find((c) => c.value === colorValue)
  if (!color) return

  document.documentElement.style.setProperty('--primary', color.primary)
}

interface InterfaceSettingsState {
  fontSize: FontSize
  accentColor: AccentColorValue
  notificationPosition: NotificationPosition
  showTokenSpeed: boolean
  coloredUserBubble: boolean
  renderHtmlArtifacts: boolean
  foldInterstitialReasoning: boolean
  setFontSize: (size: FontSize) => void
  setAccentColor: (color: AccentColorValue) => void
  setNotificationPosition: (position: NotificationPosition) => void
  setShowTokenSpeed: (show: boolean) => void
  setColoredUserBubble: (colored: boolean) => void
  setRenderHtmlArtifacts: (render: boolean) => void
  setFoldInterstitialReasoning: (fold: boolean) => void
  resetInterface: () => void
}

type InterfaceSettingsPersistedSlice = Omit<
  InterfaceSettingsState,
  | 'resetInterface'
  | 'setFontSize'
  | 'setAccentColor'
  | 'setNotificationPosition'
  | 'setShowTokenSpeed'
  | 'setColoredUserBubble'
  | 'setRenderHtmlArtifacts'
  | 'setFoldInterstitialReasoning'
>

export const fontSizeOptions = [
  { label: 'Small', value: '14px' as FontSize },
  { label: 'Medium', value: '16px' as FontSize },
  { label: 'Large', value: '18px' as FontSize },
  { label: 'Extra Large', value: '20px' as FontSize },
]

// Default interface settings
const defaultFontSize: FontSize = '16px'

const createDefaultInterfaceValues = (): InterfaceSettingsPersistedSlice => {
  return {
    fontSize: defaultFontSize,
    accentColor: DEFAULT_ACCENT_COLOR,
    notificationPosition: getDefaultNotificationPosition(),
    showTokenSpeed: true,
    coloredUserBubble: true,
    renderHtmlArtifacts: false,
    foldInterstitialReasoning: true,
  }
}

const interfaceStorage = createJSONStorage<InterfaceSettingsPersistedSlice>(() =>
  localStorage
)

export const useInterfaceSettings = create<InterfaceSettingsState>()(
  persist<
    InterfaceSettingsState,
    [],
    [],
    InterfaceSettingsPersistedSlice
  >(
    (set) => {
      const defaultState = createDefaultInterfaceValues()
      return {
        ...defaultState,
        resetInterface: () => {
          // Reset font size
          document.documentElement.style.setProperty(
            '--font-size-base',
            defaultFontSize
          )

          // Reset accent color preset
          applyAccentColorToDOM(DEFAULT_ACCENT_COLOR)

          // Update state
          set({
            fontSize: defaultFontSize,
            accentColor: DEFAULT_ACCENT_COLOR,
            notificationPosition: getDefaultNotificationPosition(),
            showTokenSpeed: true,
            coloredUserBubble: true,
            renderHtmlArtifacts: false,
            foldInterstitialReasoning: true,
          })
        },

        setAccentColor: (color: AccentColorValue) => {
          const colorExists = ACCENT_COLORS.find((c) => c.value === color)
          if (!colorExists) return

          applyAccentColorToDOM(color)
          set({ accentColor: color })
        },

        setFontSize: (size: FontSize) => {
          // Update CSS variable
          document.documentElement.style.setProperty('--font-size-base', size)
          // Update state
          set({ fontSize: size })
        },

        setNotificationPosition: (position) => {
          if (!isNotificationPosition(position)) return
          set({ notificationPosition: position })
        },

        setShowTokenSpeed: (show) => {
          set({ showTokenSpeed: show })
        },

        setColoredUserBubble: (colored) => {
          set({ coloredUserBubble: colored })
        },

        setRenderHtmlArtifacts: (render) => {
          set({ renderHtmlArtifacts: render })
        },

        setFoldInterstitialReasoning: (fold) => {
          set({ foldInterstitialReasoning: fold })
        },
      }
    },
    {
      name: localStorageKey.settingInterface,
      storage: interfaceStorage,
      partialize: (state) => ({
        fontSize: state.fontSize,
        accentColor: state.accentColor,
        notificationPosition: state.notificationPosition,
        showTokenSpeed: state.showTokenSpeed,
        coloredUserBubble: state.coloredUserBubble,
        renderHtmlArtifacts: state.renderHtmlArtifacts,
        foldInterstitialReasoning: state.foldInterstitialReasoning,
      }),
      // Apply settings when hydrating from storage
      onRehydrateStorage: () => (state) => {
        if (state) {
          // Migrate old font size value '15px' to '16px'
          if ((state.fontSize as FontSize) === '15px') {
            state.fontSize = '16px'
          }

          // Apply font size from storage
          document.documentElement.style.setProperty(
            '--font-size-base',
            state.fontSize
          )

          // Apply accent color preset
          const accentColorValue = state.accentColor || DEFAULT_ACCENT_COLOR
          applyAccentColorToDOM(accentColorValue)

          if (
            !state.notificationPosition ||
            !isNotificationPosition(state.notificationPosition)
          ) {
            state.notificationPosition = getDefaultNotificationPosition()
          }

          if (typeof state.showTokenSpeed !== 'boolean') {
            state.showTokenSpeed = true
          }

          if (typeof state.coloredUserBubble !== 'boolean') {
            state.coloredUserBubble = true
          }

          if (typeof state.renderHtmlArtifacts !== 'boolean') {
            state.renderHtmlArtifacts = false
          }

          if (typeof state.foldInterstitialReasoning !== 'boolean') {
            state.foldInterstitialReasoning = true
          }
        }

        // Return the state to be used for hydration
        return state
      },
    }
  )
)

// No theme subscription needed: --primary is theme-independent, and the sidebar
// grey is resolved by index.css via the .dark class rather than by JS.
