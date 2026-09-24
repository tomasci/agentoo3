// The one place feature code imports the toast API from — mirrors every
// other shared composition here, and keeps `@/shared/ui/toast` (CLI output,
// never hand-edited) out of feature imports directly.
//
// Usage: toast.add({ title: 'Saved', description: 'The change was applied.', type: 'success', timeout: 3000 })
//
// `type` is 'success' | 'info' | 'warning' | 'error' | 'loading' (ToastIcon in
// ui/toast.tsx); `timeout` is milliseconds, 0 to keep the toast until closed.
export { toast } from '@/shared/ui/toast'
