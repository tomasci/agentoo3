import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Providers } from '@/app/providers'
import { router } from '@/app/router'
import '@/styles/global.scss'

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from index.html')

createRoot(container).render(
  <StrictMode>
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  </StrictMode>,
)
