"use client"

import * as React from "react"
import * as SheetPrimitive from "@radix-ui/react-dialog"
import { XIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { useTitlebarLayout } from "@/stores/titlebar-layout-store"

function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />
}

function SheetTrigger({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetClose({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />
}

function SheetPortal({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        "data-[state=open]:animate-in backdrop-blur data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50",
        className
      )}
      {...props}
    />
  )
}

function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  resizable = false,
  resizeMinWidth = 420,
  resizeMaxViewportRatio = 0.5,
  ref,
  style,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: "top" | "right" | "bottom" | "left"
  showCloseButton?: boolean
  resizable?: boolean
  resizeMinWidth?: number
  resizeMaxViewportRatio?: number
}) {
  // On Windows/Linux the native window controls are an in-app overlay pinned to
  // the top-right (z-[60]); a right-side sheet only collides when the DE places
  // any control on the right (GNOME's left-side layout needs no offset).
  const controlsOnRight = useTitlebarLayout((s) => s.layout.right.length > 0)
  const offsetForTitlebar =
    side === "right" && (IS_WINDOWS || IS_LINUX) && controlsOnRight
  const contentRef = React.useRef<HTMLDivElement | null>(null)
  const resizeStartRef = React.useRef<{
    pointerId: number
    startX: number
    startWidth: number
  } | null>(null)
  const [resizedWidth, setResizedWidth] = React.useState<number | null>(null)

  const setContentRef = React.useCallback((node: HTMLDivElement | null) => {
    contentRef.current = node
    if (typeof ref === "function") {
      ref(node)
    } else if (ref) {
      ref.current = node
    }
  }, [ref])

  const widthLimits = React.useCallback(() => {
    const maximum = Math.floor(window.innerWidth * resizeMaxViewportRatio)
    return {
      minimum: Math.min(resizeMinWidth, maximum),
      maximum,
    }
  }, [resizeMaxViewportRatio, resizeMinWidth])

  React.useEffect(() => {
    if (!resizable) return
    const clampToViewport = () => {
      setResizedWidth((current) => {
        if (current === null) return current
        const { minimum, maximum } = widthLimits()
        return Math.max(minimum, Math.min(maximum, current))
      })
    }
    window.addEventListener("resize", clampToViewport)
    return () => window.removeEventListener("resize", clampToViewport)
  }, [resizable, widthLimits])

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!contentRef.current || (side !== "right" && side !== "left")) return
    event.preventDefault()
    resizeStartRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: contentRef.current.getBoundingClientRect().width,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    document.documentElement.style.cursor = "col-resize"
    document.documentElement.style.userSelect = "none"
  }

  const continueResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current
    if (!start || start.pointerId !== event.pointerId) return
    const direction = side === "right" ? 1 : -1
    const proposedWidth = start.startWidth + direction * (start.startX - event.clientX)
    const { minimum, maximum } = widthLimits()
    setResizedWidth(Math.max(minimum, Math.min(maximum, proposedWidth)))
  }

  const finishResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current
    if (!start || start.pointerId !== event.pointerId) return
    resizeStartRef.current = null
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    document.documentElement.style.cursor = ""
    document.documentElement.style.userSelect = ""
  }

  React.useEffect(() => () => {
    document.documentElement.style.cursor = ""
    document.documentElement.style.userSelect = ""
  }, [])

  const canResize = resizable && (side === "right" || side === "left")
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        ref={setContentRef}
        data-slot="sheet-content"
        className={cn(
          "bg-background data-[state=open]:animate-in data-[state=closed]:animate-out fixed z-50 flex flex-col gap-4 shadow-lg transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500",
          side === "right" &&
            "data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right inset-y-0 right-0 h-full w-3/4 border-l sm:max-w-sm",
          side === "left" &&
            "data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm",
          side === "top" &&
            "data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top inset-x-0 top-0 h-auto border-b",
          side === "bottom" &&
            "data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom inset-x-0 bottom-0 h-auto border-t",
          offsetForTitlebar && "pt-15",
          className
        )}
        style={{
          ...style,
          ...(canResize ? { maxWidth: `${resizeMaxViewportRatio * 100}vw` } : null),
          ...(resizedWidth === null ? null : { width: `${resizedWidth}px` }),
        }}
        {...props}
      >
        {canResize && (
          <div
            role="separator"
            aria-label="Resize panel"
            aria-orientation="vertical"
            title="Drag to resize"
            className={cn(
              "group absolute inset-y-0 z-[70] flex w-3 touch-none cursor-col-resize items-center justify-center bg-background/70 hover:bg-primary/20",
              side === "right" ? "left-0 border-r border-border" : "right-0 border-l border-border"
            )}
            onPointerDown={beginResize}
            onPointerMove={continueResize}
            onPointerUp={finishResize}
            onPointerCancel={finishResize}
            onLostPointerCapture={finishResize}
          >
            <span className="h-16 w-1 rounded-full bg-primary/70 transition-colors group-hover:bg-primary group-active:bg-primary" />
          </div>
        )}
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close className={cn(
            "ring-offset-background focus:ring-ring data-[state=open]:bg-secondary absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none",
            offsetForTitlebar && "top-15"
          )}>
            <XIcon className="size-4" />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-1.5 p-4", className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  )
}

function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-foreground font-semibold pr-8", className)}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
