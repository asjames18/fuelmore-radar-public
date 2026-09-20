import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { shortAddress } from '../lib/format'

export const DONATE_ADDRESS = '0x995ff20448507459baf3b4ae1d2192e2b4a41f7a'
export const DONATE_NETWORK_NOTE = 'Robinhood Chain (chain ID 4663)'

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

export function DonateChip() {
  const [copied, setCopied] = useState(false)

  const onCopy = async () => {
    const ok = await copyText(DONATE_ADDRESS)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <button
      type="button"
      className="donate-chip"
      onClick={() => void onCopy()}
      title={`Donations support the Radar. Send on ${DONATE_NETWORK_NOTE} — funds sent on other networks may be lost. Click to copy the address.`}
      aria-label={`Copy donation address. Donations support the Radar. Send on ${DONATE_NETWORK_NOTE} only.`}
    >
      <span className="donate-label">Support the Radar</span>
      <code>{shortAddress(DONATE_ADDRESS)}</code>
      {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
      <span className="donate-state" aria-live="polite">{copied ? 'Copied' : ''}</span>
    </button>
  )
}
