import { motion } from 'framer-motion'
import { useMemo } from 'react'
import { cn } from '../lib/utils'

interface TextShimmerProps {
    children: string
    className?: string
    duration?: number
    spread?: number
}

/**
 * TextShimmer — a light sweep across text, matching the Codex-style thinking animation.
 * Base color is dim zinc (#71717a), shimmer light sweeps bright white.
 */
export default function TextShimmer({
    children,
    className,
    duration = 2,
    spread = 2,
}: TextShimmerProps): JSX.Element {
    const dynamicSpread = useMemo(() => children.length * spread, [children, spread])

    return (
        <motion.span
            className={cn(
                'inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent',
                '[--base-color:#52525b] dark:[--base-color:#52525b]',
                '[--base-gradient-color:#e4e4e7] dark:[--base-gradient-color:#e4e4e7]',
                '[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--base-gradient-color),#0000_calc(50%+var(--spread)))]',
                '[background-repeat:no-repeat,padding-box]',
                className,
            )}
            initial={{ backgroundPosition: '105% center' }}
            animate={{ backgroundPosition: '-5% center' }}
            transition={{ repeat: Infinity, duration, ease: 'linear' }}
            style={{
                '--spread': `${dynamicSpread}px`,
                backgroundImage: 'var(--bg), linear-gradient(var(--base-color), var(--base-color))',
            } as React.CSSProperties}
        >
            {children}
        </motion.span>
    )
}
