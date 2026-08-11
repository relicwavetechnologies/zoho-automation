/** @type {import('tailwindcss').Config} */
export default {
    darkMode: ["class"],
    content: [
    "./index.html",
    "./src/**/*.{ts,tsx,js,jsx}"
  ],
  theme: {
  	extend: {
  		fontFamily: {
  			sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
  			studio: ['StudioFeixenSans', 'Inter', 'sans-serif'],
  			mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace']
  		},
  		borderRadius: {
  			lg: 'var(--radius)',
  			md: 'calc(var(--radius) - 2px)',
  			sm: 'calc(var(--radius) - 4px)',
  			/* chat surface: chip → control → card. Derived from the same
  			   `--radius` as everything else, so the trace's corners match the
  			   app's rather than being three more numbers to keep in step. */
  			chip: 'calc(var(--radius) - 6px)',
  			control: 'calc(var(--radius) - 4px)',
  			card: 'calc(var(--radius) - 2px)'
  		},
  		boxShadow: {
  			hairline: 'var(--bui-shadow-hairline)',
  			btn: 'var(--bui-shadow-btn)',
  			card: 'var(--bui-shadow-card)',
  			raised: 'var(--bui-shadow-raised)',
  			overlay: 'var(--bui-shadow-overlay)'
  		},
  		colors: {
  			background: 'hsl(var(--background))',
  			foreground: 'hsl(var(--foreground))',
  			card: {
  				DEFAULT: 'hsl(var(--card))',
  				foreground: 'hsl(var(--card-foreground))'
  			},
  			mat: {
  				DEFAULT: 'hsl(var(--mat))',
  				foreground: 'hsl(var(--mat-foreground))'
  			},
  			popover: {
  				DEFAULT: 'hsl(var(--popover))',
  				foreground: 'hsl(var(--popover-foreground))'
  			},
  			primary: {
  				DEFAULT: 'hsl(var(--primary))',
  				foreground: 'hsl(var(--primary-foreground))'
  			},
  			secondary: {
  				DEFAULT: 'hsl(var(--secondary))',
  				foreground: 'hsl(var(--secondary-foreground))'
  			},
  			muted: {
  				DEFAULT: 'hsl(var(--muted))',
  				foreground: 'hsl(var(--muted-foreground))'
  			},
  			accent: {
  				DEFAULT: 'hsl(var(--accent))',
  				foreground: 'hsl(var(--accent-foreground))'
  			},
  			destructive: {
  				DEFAULT: 'hsl(var(--destructive))',
  				foreground: 'hsl(var(--destructive-foreground))'
  			},
  			success: {
  				DEFAULT: 'hsl(var(--success))',
  				foreground: 'hsl(var(--success-foreground))'
  			},
  			warning: {
  				DEFAULT: 'hsl(var(--warning))',
  				foreground: 'hsl(var(--warning-foreground))'
  			},
  			emphasis: {
  				DEFAULT: 'hsl(var(--emphasis))',
  				foreground: 'hsl(var(--emphasis-foreground))'
  			},
  			border: 'hsl(var(--border))',
  			input: 'hsl(var(--input))',
  			ring: 'hsl(var(--ring))',
  			chart: {
  				'1': 'hsl(var(--chart-1))',
  				'2': 'hsl(var(--chart-2))',
  				'3': 'hsl(var(--chart-3))',
  				'4': 'hsl(var(--chart-4))',
  				'5': 'hsl(var(--chart-5))'
  			},
  			/* pastel AI-timeline stages — agent trace only (see TraceStage) */
  			timeline: {
  				thinking: 'hsl(var(--tl-thinking))',
  				grep: 'hsl(var(--tl-grep))',
  				read: 'hsl(var(--tl-read))',
  				edit: 'hsl(var(--tl-edit))',
  				done: 'hsl(var(--tl-done))'
  			},
  			/* Chat-surface neutrals (see styles/beautiful.css). A finer scale
  			   than the shadcn tokens: three ink weights and two hairlines, which
  			   is what the trace/tool rows need to stay quiet. Semantic colour
  			   still comes from the shadcn tokens above — `text-success`,
  			   `text-destructive`, `text-primary` — so there is one green. */
  			ink: {
  				DEFAULT: 'var(--bui-ink)',
  				2: 'var(--bui-ink-2)',
  				3: 'var(--bui-ink-3)'
  			},
  			surface: 'var(--bui-surface)',
  			inset: 'var(--bui-inset)',
  			field: 'var(--bui-field)',
  			canvas: 'var(--bui-canvas)',
  			page: 'var(--bui-page)',
  			line: {
  				DEFAULT: 'var(--bui-line)',
  				strong: 'var(--bui-line-strong)'
  			},
  			fill: {
  				DEFAULT: 'var(--bui-hover)',
  				strong: 'var(--bui-hover-2)'
  			},
  			sidebar: {
  				DEFAULT: 'hsl(var(--sidebar-background))',
  				foreground: 'hsl(var(--sidebar-foreground))',
  				primary: 'hsl(var(--sidebar-primary))',
  				'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
  				accent: 'hsl(var(--sidebar-accent))',
  				'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
  				border: 'hsl(var(--sidebar-border))',
  				ring: 'hsl(var(--sidebar-ring))'
  			}
  		},
  		keyframes: {
  			'accordion-down': {
  				from: {
  					height: '0'
  				},
  				to: {
  					height: 'var(--radix-accordion-content-height)'
  				}
  			},
  			'accordion-up': {
  				from: {
  					height: 'var(--radix-accordion-content-height)'
  				},
  				to: {
  					height: '0'
  				}
  			}
  		},
  		animation: {
  			'accordion-down': 'accordion-down 0.2s ease-out',
  			'accordion-up': 'accordion-up 0.2s ease-out'
  		}
  	}
  },
  plugins: [require("tailwindcss-animate")],
}

