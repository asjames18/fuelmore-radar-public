import { ArrowDownRight, ArrowUpRight, ExternalLink } from 'lucide-react'
import { DEXSCREENER } from '../lib/contracts'
import { formatChange, formatUsd, shortAddress } from '../lib/format'
import type { HolderSummary, PairSnapshot } from '../lib/types'

type Props = { pair: PairSnapshot; holders?: HolderSummary }

export function MarketCard({ pair, holders }: Props) {
  const change = pair.change24h
  const positive = change == null ? null : change >= 0
  const Mark = positive === false ? ArrowDownRight : ArrowUpRight
  return (
    <article className={`market-card market-${pair.symbol.toLowerCase()}`}>
      <div className="market-head">
        <div className="token-lockup">
          <div className="token-mark" aria-hidden="true">{pair.symbol[0]}</div>
          <div>
            <h2>{pair.symbol}</h2>
            <p>{pair.name}</p>
          </div>
        </div>
        <div className="price-block">
          <strong>{formatUsd(pair.priceUsd)}</strong>
          <span className={positive == null ? '' : positive ? 'positive' : 'negative'}>{positive != null && <Mark size={15} />}{formatChange(pair.change24h)}</span>
        </div>
        <a className="icon-link" href={`${DEXSCREENER}/${pair.pairAddress}`} target="_blank" rel="noreferrer" aria-label={`Open ${pair.symbol} pool on Dexscreener`}>
          <ExternalLink size={16} />
        </a>
      </div>
      <div className="market-metrics">
        <div><span>Liquidity</span><b>{formatUsd(pair.liquidityUsd, true)}</b></div>
        <div><span>24h volume</span><b>{formatUsd(pair.volume24h, true)}</b></div>
        <div><span>Pool</span><b>{pair.version.toUpperCase()} · {shortAddress(pair.pairAddress, 5, 4)}</b></div>
        <div><span>Holders</span><b>{holders?.totalHolders?.toLocaleString() || '—'}</b></div>
      </div>
    </article>
  )
}
