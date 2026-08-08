const ENVIRONMENT_NAME_LABELS: Record<string, string> = {
  Development: 'Phát triển',
  'User Acceptance Test': 'Kiểm thử UAT',
  UAT: 'Kiểm thử UAT',
  Production: 'Sản xuất',
}

export function displayEnvironmentName(name: string): string {
  return ENVIRONMENT_NAME_LABELS[name] ?? name
}
