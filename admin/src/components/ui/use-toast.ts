import { useState, useEffect, useCallback } from 'react';

export type ToastProps = {
    id: string;
    title?: string;
    description?: string;
    variant?: 'default' | 'success' | 'destructive';
};

type ToastActionElement = Omit<ToastProps, 'id'>;

let memoryState: ToastProps[] = [];
let listeners: ((state: ToastProps[]) => void)[] = [];

function dispatch(action: { type: 'ADD_TOAST'; toast: ToastProps } | { type: 'REMOVE_TOAST'; toastId: string }) {
    if (action.type === 'ADD_TOAST') {
        memoryState = [action.toast, ...memoryState].slice(0, 3);
    } else if (action.type === 'REMOVE_TOAST') {
        memoryState = memoryState.filter((t) => t.id !== action.toastId);
    }
    listeners.forEach((listener) => listener(memoryState));
}

let count = 0;
function genId() {
    count = (count + 1) % Number.MAX_VALUE;
    return count.toString();
}

export function toast(props: ToastActionElement) {
    const id = genId();
    const update = {
        id,
        ...props,
    };
    dispatch({ type: 'ADD_TOAST', toast: update });

    setTimeout(() => {
        dispatch({ type: 'REMOVE_TOAST', toastId: id });
    }, 4000);

    return {
        id: id,
        dismiss: () => dispatch({ type: 'REMOVE_TOAST', toastId: id }),
    };
}

export function useToast() {
    const [toasts, setToasts] = useState<ToastProps[]>(memoryState);

    useEffect(() => {
        listeners.push(setToasts);
        return () => {
            const index = listeners.indexOf(setToasts);
            if (index > -1) {
                listeners.splice(index, 1);
            }
        };
    }, []);

    return {
        toasts,
        toast,
        dismiss: (toastId?: string) => {
            if (toastId) {
                dispatch({ type: 'REMOVE_TOAST', toastId });
            } else {
                memoryState.forEach((t) => dispatch({ type: 'REMOVE_TOAST', toastId: t.id }));
            }
        },
    };
}
