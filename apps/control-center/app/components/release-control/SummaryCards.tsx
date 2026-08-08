type SummaryCard = {
  label: string
  value: React.ReactNode
}

type SummaryCardsProps = {
  environmentsCount: number
  agentsOnlineCount: number
  healthyServicesCount: number
  lastUpdatedLabel: string
}

export function SummaryCards({
  environmentsCount,
  agentsOnlineCount,
  healthyServicesCount,
  lastUpdatedLabel,
}: SummaryCardsProps) {
  const cards: SummaryCard[] = [
    { label: 'Môi trường', value: environmentsCount },
    { label: 'Agent đang kết nối', value: agentsOnlineCount },
    { label: 'Dịch vụ hoạt động', value: healthyServicesCount },
    { label: 'Cập nhật lúc', value: lastUpdatedLabel },
  ]

  return (
    <section className="mb-5 grid w-full grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((card) => (
        <div
          key={card.label}
          className="rounded border border-slate-800 bg-slate-900/50 px-4 py-3"
        >
          <span className="mb-1 block text-xs text-slate-500">{card.label}</span>
          <strong className="block truncate text-xl font-semibold text-slate-100">{card.value}</strong>
        </div>
      ))}
    </section>
  )
}
