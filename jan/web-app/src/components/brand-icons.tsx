import { useId, type SVGProps } from 'react'

type BrandIconProps = SVGProps<SVGSVGElement> & {
  title?: string
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
