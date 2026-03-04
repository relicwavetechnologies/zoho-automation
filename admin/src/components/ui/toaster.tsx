import { useToast } from './use-toast';
import { X, CheckCircle2, AlertCircle, Info } from 'lucide-react';
import { cn } from '../../lib/utils';

export function Toaster() {
    const { toasts, dismiss } = useToast();

    return (
        <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-full max-w-sm pointer-events-none">
            {toasts.map(function ({ id, title, description, variant = 'default' }) {
                return (
                    <div
                        key={id}
                        className={cn(
                            "pointer-events-auto flex w-full items-start gap-3 rounded-md border p-4 shadow-lg transition-all",
                            variant === 'default' && "bg-[#111] border-[#222] text-zinc-300",
                            variant === 'success' && "bg-emerald-950/30 border-emerald-900/50 text-emerald-400",
                            variant === 'destructive' && "bg-red-950/30 border-red-900/50 text-red-400"
                        )}
                    >
                        <div className="mt-0.5 shrink-0">
                            {variant === 'default' && <Info className="h-4 w-4 text-zinc-500" />}
                            {variant === 'success' && <CheckCircle2 className="h-4 w-4" />}
                            {variant === 'destructive' && <AlertCircle className="h-4 w-4" />}
                        </div>

                        <div className="flex-1 flex flex-col gap-1">
                            {title && <h3 className="text-sm font-medium">{title}</h3>}
                            {description && <p className="text-xs opacity-90">{description}</p>}
                        </div>

                        <button
                            onClick={() => dismiss(id)}
                            className={cn(
                                "inline-flex shrink-0 rounded-md p-1 opacity-50 hover:opacity-100 transition-opacity focus:outline-none focus:ring-1",
                                variant === 'default' ? "hover:bg-[#222] focus:ring-zinc-600" : "hover:bg-white/10 focus:ring-current"
                            )}
                        >
                            <X className="h-4 w-4" />
                            <span className="sr-only">Close</span>
                        </button>
                    </div>
                );
            })}
        </div>
    );
}
