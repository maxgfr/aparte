import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Toast, type ToastAction } from '../ui/components/Toast.tsx'

interface ToastState {
  id: number
  message: string
  actions?: readonly ToastAction[]
}

type Show = (message: string, actions?: readonly ToastAction[]) => void

const ToastContext = createContext<Show>(() => {})

export function useToast(): Show {
  return useContext(ToastContext)
}

/** One toast at a time; it stays 5 s (8 s with an action such as Undo), a newer one replacing it. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null)
  const next = useRef(0)
  const show = useCallback<Show>((message, actions) => {
    next.current++
    setToast({ id: next.current, message, ...(actions ? { actions } : {}) })
  }, [])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast((cur) => (cur?.id === toast.id ? null : cur)), toast.actions ? 8000 : 5000)
    return () => clearTimeout(t)
  }, [toast])
  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <Toast
          key={toast.id}
          message={toast.message}
          actions={toast.actions?.map((a) => ({
            label: a.label,
            onClick: () => {
              setToast(null)
              a.onClick()
            },
          }))}
        />
      )}
    </ToastContext.Provider>
  )
}
