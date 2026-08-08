import type { Metadata } from 'next'
import { Quicksand } from 'next/font/google'
import './globals.css'

const quicksand = Quicksand({
  subsets: ['latin', 'vietnamese'],
  display: 'swap',
  variable: '--font-quicksand',
})

export const metadata: Metadata = {
  title: 'Quản lý triển khai IPS',
  description: 'Quản lý triển khai tập trung cho DEV, UAT và PROD',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi" className={quicksand.variable}>
      <body className="min-h-screen bg-slate-950 font-sans text-slate-100 antialiased" suppressHydrationWarning>{children}</body>
    </html>
  )
}
