import type { Metadata } from 'next'
import { Quicksand } from 'next/font/google'
import './globals.css'
import { ACTIVE_PROJECT_PROFILE } from '../lib/projectProfile'

const quicksand = Quicksand({
  subsets: ['latin', 'vietnamese'],
  display: 'swap',
  variable: '--font-quicksand',
})

export const metadata: Metadata = {
  title: ACTIVE_PROJECT_PROFILE.applicationName,
  description: 'Quản lý triển khai tập trung cho DEV, UAT và PROD',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi" className={quicksand.variable}>
      <body className="min-h-screen bg-slate-950 font-sans text-slate-100 antialiased" suppressHydrationWarning>{children}</body>
    </html>
  )
}
