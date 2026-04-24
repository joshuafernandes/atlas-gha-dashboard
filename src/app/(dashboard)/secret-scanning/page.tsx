import { SecretScanAlerts } from '@/components/common/SecretScanAlerts'

export const metadata = { title: 'Secret Scanning · GHA Dashboard' }

export default function SecretScanningPage() {
  return <SecretScanAlerts />
}
