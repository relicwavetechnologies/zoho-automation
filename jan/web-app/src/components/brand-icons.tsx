import { useId, type SVGProps } from 'react'

type BrandIconProps = SVGProps<SVGSVGElement> & {
  title?: string
}

/** Compact Canva-style mark for the local desktop catalogue. */
export function CanvaIcon({ title = 'Canva', ...props }: BrandIconProps) {
  const gradientSuffix = useId().replaceAll(':', '')
  const gradientId = `canva-${gradientSuffix}`
  return (
    <svg viewBox="0 0 48 48" role="img" aria-label={title} {...props}>
      <defs>
        <linearGradient id={gradientId} x1="7" y1="41" x2="41" y2="7" gradientUnits="userSpaceOnUse">
          <stop stopColor="#00C4CC" />
          <stop offset="1" stopColor="#7D2AE8" />
        </linearGradient>
      </defs>
      <circle cx="24" cy="24" r="21" fill={`url(#${gradientId})`} />
      <path d="M32.3 16.2c-1.7-1.4-3.8-2.1-6.1-2.1-5.7 0-10.3 4.4-10.3 9.9 0 5.6 4.6 9.9 10.3 9.9 2.4 0 4.5-.7 6.1-2.1l-1.8-2.4c-1.2.9-2.6 1.4-4.2 1.4-3.7 0-6.5-2.8-6.5-6.8s2.8-6.8 6.5-6.8c1.5 0 3 .5 4.2 1.4z" fill="white" />
    </svg>
  )
}

/** Official Gmail 2026 product mark, bundled locally for offline desktop use. */
export function GmailIcon({ title = 'Gmail', ...props }: BrandIconProps) {
  const gradientSuffix = useId().replaceAll(':', '')
  const sideGradientId = `gmail-side-${gradientSuffix}`
  const topGradientId = `gmail-top-${gradientSuffix}`

  return (
    <svg
      viewBox="0 0 192 192"
      fill="none"
      role="img"
      aria-label={title}
      {...props}
    >
      <path
        fill={`url(#${sideGradientId})`}
        d="M146 44h38v110c0 6.627-5.373 12-12 12h-20a6 6 0 0 1-6-6z"
      />
      <path
        fill="#fc413d"
        d="M46 44H8v110c0 6.627 5.373 12 12 12h20a6 6 0 0 0 6-6z"
      />
      <path
        fill={`url(#${topGradientId})`}
        d="M39.226 30.456c-8.033-6.752-20.018-5.714-26.77 2.319-6.752 8.032-5.714 20.017 2.319 26.77l76.078 63.949a8 8 0 0 0 10.295 0l76.078-63.95c8.032-6.752 9.07-18.737 2.318-26.77-6.752-8.032-18.737-9.07-26.769-2.318L96 78.18z"
      />
      <defs>
        <linearGradient
          id={sideGradientId}
          x1="165"
          x2="165"
          y1="44"
          y2="166"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#60d673" />
          <stop offset=".17" stopColor="#42c868" />
          <stop offset=".39" stopColor="#0ebc5f" />
          <stop offset=".62" stopColor="#00a9bb" />
          <stop offset=".86" stopColor="#3c90ff" />
          <stop offset="1" stopColor="#3186ff" />
        </linearGradient>
        <linearGradient
          id={topGradientId}
          x1="8"
          x2="184"
          y1="46.13"
          y2="46.13"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".08" stopColor="#ff63a0" />
          <stop offset=".3" stopColor="#fc413d" />
          <stop offset=".5" stopColor="#fc413d" />
          <stop offset=".65" stopColor="#fc413d" />
          <stop offset=".72" stopColor="#fc5c30" />
          <stop offset=".86" stopColor="#feb10c" />
          <stop offset=".91" stopColor="#fec700" />
          <stop offset=".96" stopColor="#ffdb0f" />
        </linearGradient>
      </defs>
    </svg>
  )
}

/** Official Google "G" four-color brand mark, bundled locally for offline desktop use. */
export function GoogleIcon({ title = 'Google', ...props }: BrandIconProps) {
  return (
    <svg viewBox="0 0 48 48" role="img" aria-label={title} {...props}>
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
    </svg>
  )
}

/** Official Google Drive triangular brand mark, bundled locally for offline desktop use. */
export function GoogleDriveIcon({ title = 'Google Drive', ...props }: BrandIconProps) {
  return (
    <svg viewBox="0 0 87.3 78" role="img" aria-label={title} {...props}>
      <path
        fill="#0066da"
        d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z"
      />
      <path
        fill="#00ac47"
        d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z"
      />
      <path
        fill="#ea4335"
        d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z"
      />
      <path
        fill="#00832d"
        d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z"
      />
      <path
        fill="#2684fc"
        d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z"
      />
      <path
        fill="#ffba00"
        d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z"
      />
    </svg>
  )
}

/** Official Google Calendar brand mark, bundled locally for offline desktop use. */
export function GoogleCalendarIcon({ title = 'Google Calendar', ...props }: BrandIconProps) {
  return (
    <svg viewBox="0 0 200 200" role="img" aria-label={title} {...props}>
      <path fill="#fff" d="M152 48H48v104h104z" />
      <path fill="#ea4335" d="M152 200l48-48-24-4.174L152 152l-5.9 22.775z" />
      <path fill="#188038" d="M0 152v36c0 6.628 5.372 12 12 12h36l7.746-24L48 152l-25.171-4z" />
      <path fill="#1967d2" d="M200 48V12c0-6.628-5.372-12-12-12h-36l-7.507 24L152 48l24 4.174z" />
      <path fill="#fbbc04" d="M200 152V48h-48v104z" />
      <path fill="#4285f4" d="M152 200H12c-6.628 0-12-5.372-12-12v-36h152z" />
      <path fill="#34a853" d="M0 48h152V0H12C5.372 0 0 5.372 0 12z" />
      <path
        fill="#4285f4"
        d="M68.53 121.53c-3.988-2.696-6.75-6.635-8.26-11.83l9.02-3.717c.84 3.204 2.31 5.688 4.41 7.45 2.085 1.762 4.63 2.63 7.6 2.63 3.04 0 5.65-.924 7.83-2.77 2.18-1.847 3.28-4.2 3.28-7.044 0-2.912-1.153-5.294-3.46-7.14s-5.2-2.77-8.64-2.77h-5.215v-8.932H81.6c2.96 0 5.454-.8 7.484-2.4 2.03-1.6 3.045-3.786 3.045-6.567 0-2.474-.906-4.446-2.72-5.926-1.813-1.48-4.108-2.226-6.896-2.226-2.72 0-4.882.72-6.49 2.174a12.65 12.65 0 0 0 -3.276 5.16l-8.925-3.717c1.084-3.06 3.06-5.763 5.952-8.1 2.892-2.337 6.594-3.51 11.088-3.51 3.32 0 6.31.64 8.955 1.926 2.646 1.286 4.723 3.068 6.223 5.34s2.247 4.82 2.247 7.64c0 2.878-.693 5.313-2.08 7.312-1.386 2-3.09 3.53-5.11 4.598v.534a15.51 15.51 0 0 1 6.554 5.106c1.7 2.29 2.556 5.03 2.556 8.23 0 3.2-.81 6.06-2.43 8.573-1.62 2.513-3.86 4.494-6.71 5.94-2.86 1.446-6.074 2.174-9.645 2.174-4.135.008-7.953-1.34-11.94-4.036z"
      />
      <path
        fill="#4285f4"
        d="M126.53 77.9l-9.9 7.156-4.977-7.545 17.87-12.9h6.822v60.876h-9.815z"
      />
    </svg>
  )
}

/** Official Zoho four-tile brand mark, cropped for compact product surfaces. */
export function ZohoIcon({ title = 'Zoho', ...props }: BrandIconProps) {
  return (
    <svg
      viewBox="0 0 1024 365"
      fill="none"
      role="img"
      aria-label={title}
      {...props}
    >
      <path
        fill="#089949"
        d="M458.1 353c-7.7 0-15.5-1.6-23-4.9l-160-71.3c-28.6-12.7-41.5-46.4-28.8-75l71.3-160c12.7-28.6 46.4-41.5 75-28.8l160 71.3c28.6 12.7 41.5 46.4 28.8 75l-71.3 160c-9.5 21.2-30.3 33.7-52 33.7Zm-9.7-34.9c12.1 5.4 26.3-.1 31.7-12.1l71.3-160c5.4-12.1-.1-26.3-12.1-31.7L379.2 43c-12.1-5.4-26.3.1-31.7 12.1l-71.3 160c-5.4 12.1.1 26.3 12.1 31.7l160.1 71.3Z"
      />
      <path
        fill="#F9B21D"
        d="M960 353.1H784.8c-31.3 0-56.8-25.5-56.8-56.8V121.1c0-31.3 25.5-56.8 56.8-56.8H960c31.3 0 56.8 25.5 56.8 56.8v175.2c0 31.3-25.5 56.8-56.8 56.8ZM784.8 97.1c-13.2 0-24 10.8-24 24v175.2c0 13.2 10.8 24 24 24H960c13.2 0 24-10.8 24-24V121.1c0-13.2-10.8-24-24-24H784.8Z"
      />
      <path
        fill="#E42527"
        d="m303.9 153.2-23.6 52.8-.9 1.6 9.2 56.8c2.1 13.1-6.8 25.4-19.8 27.5l-173 28c-6.3 1-12.7-.5-17.9-4.2-5.2-3.7-8.6-9.3-9.6-15.6l-28-173c-1-6.3.5-12.7 4.2-17.9 3.7-5.2 9.3-8.6 15.6-9.6l173-28c1.3-.2 2.6-.3 3.8-.3 11.5 0 21.8 8.4 23.7 20.2l9.3 57.2L294.3 94l-1.3-7.7c-5-30.9-34.2-52-65.1-47l-173 28C40 69.6 26.8 77.7 18 90c-8.9 12.3-12.4 27.3-10 42.3l28 173c2.4 15 10.5 28.1 22.8 37 9.7 7.1 21.2 10.7 33.1 10.7 3 0 6.1-.2 9.2-.7l173-28c30.9-5 52-34.2 47-65.1l-17.2-106Z"
      />
      <path
        fill="#226DB4"
        d="m511.4 235.8 25.4-56.9-7.2-52.9c-.9-6.3.8-12.6 4.7-17.7 3.9-5.1 9.5-8.4 15.9-9.2l173.6-23.6c1.1-.1 2.2-.2 3.3-.2 5.2 0 10.2 1.7 14.5 4.9.8.6 1.5 1.3 2.2 1.9 7.7-8.1 17.8-13.9 29.1-16.4-3.2-4.4-7-8.3-11.5-11.7-12.1-9.2-27-13.1-42-11.1L545.6 66.5c-15 2-28.4 9.8-37.5 21.9-9.2 12.1-13.1 27-11.1 42l14.4 105.4Zm295.4 29.3L784 97.1c-12.8.4-23.1 11-23.1 23.9v49.3l13.5 99.2c.9 6.3-.8 12.6-4.7 17.7s-9.5 8.4-15.9 9.2L580.2 320c-6.3.9-12.6-.8-17.7-4.7-5.1-3.9-8.4-9.5-9.2-15.9l-8-58.9-25.4 56.9.9 6.4c2 15 9.8 28.4 21.9 37.5 10 7.6 21.9 11.6 34.3 11.6 2.6 0 5.2-.2 7.8-.5L758.2 329c15-2 28.4-9.8 37.5-21.9 9.2-12.1 13.1-27 11.1-42Z"
      />
    </svg>
  )
}

/**
 * Official Lark mark: two overlapping wings forming a dove.
 *
 * Traced from Lark's own artwork, so the geometry and the three brand colours
 * (`#4C6FFB` blue, `#78D5B9` teal, `#293E96` where they overlap) are exact
 * rather than approximated — the previous hand-drawn "swallow on a gradient
 * tile" was not the real logo. Draw order matters: the overlap is painted last,
 * on top of both wings.
 */
export function LarkIcon({ title = 'Lark', ...props }: BrandIconProps) {
  return (
    <svg
      viewBox="20.9 33.7 156.8 127.9"
      fill="none"
      role="img"
      aria-label={title}
      {...props}
    >
      <path
        fill="#4C6FFB"
        d="M62.8 156.2C46.2 153.6 26.1 144.7 23.5 138.9C22.1 135.9 21.9 71.7 23.3 71.2C23.8 71 26.4 73.2 31.4 78.1C45.1 91.5 59.7 102 77.1 111L82.3 113.7L86 111.6C92.8 107.7 98.6 102.9 109.5 92.2C115.4 86.4 121.7 80.6 123.6 79.3C138.1 69 157.7 67.1 174.7 74.2L176.6 75.1L174.3 77.5C170.8 81.2 168.2 85.7 161.8 98.4C153.3 115.4 148.8 122.1 140.5 130.5C120.7 150.5 90 160.6 62.8 156.2Z"
      />
      <path
        fill="#78D5B9"
        d="M118 126.2C113.3 125.2 105 122.7 99.1 120.5C83.4 114.6 81.2 113.1 85.7 111.7C86.3 111.5 86.9 111.2 87 111C87.1 110.9 88.5 109.9 90 109C91.5 108.1 92.9 107.2 93 107C93.1 106.8 93.9 106.2 94.8 105.6C103.2 99.3 103 100 98.8 93.1C86.7 73 70.6 54.9 51.6 40C49 38 47 36.1 47.1 35.8C47.3 35.2 113.6 34.7 116.9 35.3C122.1 36.2 136.8 61.8 137.6 71.3C137.7 71.9 137.9 72.3 138.1 72.2C138.3 72.1 138.9 71.8 139.5 71.7C140.5 71.5 141.1 71.4 143.6 70.7C148.6 69.5 158 69.5 163.5 70.7C164.2 70.9 165.5 71.1 166.5 71.3C167.5 71.5 168.5 71.8 168.9 72.1C169.2 72.4 169.5 72.5 169.5 72.2C169.5 72 169.9 72.2 170.3 72.6C170.8 72.9 171.2 73.2 171.2 73C171.3 72.6 174.9 74.1 175.5 74.8C176 75.3 175.6 76.1 173.5 78.6C169.1 84 170 82.4 162.7 97.1C159.4 103.7 156.6 109 156.4 109C156.2 109 155.9 109.5 155.7 110.1C155.5 110.6 155.1 111.5 154.7 111.9C154.3 112.4 154 112.9 154.1 113C154.2 113.2 152.3 115 150 117.2C141.1 125.4 129.4 128.7 118 126.2Z"
      />
      <path
        fill="#293E96"
        d="M118 126.2C110.1 124.5 91.1 117.8 84.5 114.5L82.8 113.6L84.3 112.7C94.5 106.5 97.3 104.2 109.5 92.2C115.4 86.4 121.7 80.7 123.5 79.4C136.6 70.1 154.1 67.5 169.8 72.5C176.6 74.7 176.7 74.8 173.9 77.9C170.3 81.9 168.6 84.9 162.5 97C155.5 110.9 153.8 113.7 149.4 117.8C141.2 125.3 129 128.6 118 126.2Z"
      />
    </svg>
  )
}
