import { Monitor, Moon, Sun } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useTheme } from "@/lib/use-theme"
import { cn } from "@/lib/utils"

export function ThemeToggle() {
  const { theme, resolved, toggle } = useTheme()

  const tooltip =
    theme === "light" ? "Switch to dark mode" : theme === "dark" ? "Match system theme" : "Switch to light mode"

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="relative h-8 w-8 overflow-hidden rounded-full border-border/50 bg-card shadow-soft hover:bg-card"
          onClick={toggle}
          aria-label={tooltip}
        >
          <Sun
            className={cn(
              "absolute h-3.5 w-3.5 transition-all duration-300",
              theme === "light"
                ? "rotate-0 scale-100 opacity-100"
                : "rotate-90 scale-0 opacity-0",
            )}
            aria-hidden="true"
          />
          <Moon
            className={cn(
              "absolute h-3.5 w-3.5 transition-all duration-300",
              theme === "dark"
                ? "rotate-0 scale-100 opacity-100"
                : "-rotate-90 scale-0 opacity-0",
            )}
            aria-hidden="true"
          />
          <Monitor
            className={cn(
              "absolute h-3.5 w-3.5 transition-all duration-300",
              theme === "system"
                ? "rotate-0 scale-100 opacity-100"
                : "rotate-90 scale-0 opacity-0",
            )}
            aria-hidden="true"
          />
          <span className="sr-only">
            Theme: {theme} ({resolved})
          </span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  )
}
