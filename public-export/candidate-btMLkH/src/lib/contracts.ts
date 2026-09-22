import { defineChain, parseAbi } from 'viem'

const DIRECT_RPC = 'https://rpc.mainnet.chain.robinhood.com'

/** Same-origin `/rpc` in the browser (Vite proxy or Cloudflare Worker); direct RPC in Node. */
export function resolveRpcUrl(origin?: string) {
  return origin ? `${origin.replace(/\/$/, '')}/rpc` : DIRECT_RPC
}

export const RPC_URL = resolveRpcUrl(typeof window !== 'undefined' ? window.location?.origin : undefined)

export const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [RPC_URL] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  },
  contracts: {
    multicall3: {
      // EIP-55 checksum only; same canonical Multicall3 identity.
      address: '0xcA11bde05977b3631167028862bE2a173976CA11',
    },
  },
})

export const CONTRACTS = [
  { key: 'fuel', name: 'FUEL Token', type: 'ERC-20 token', address: '0xe60C1F5d9bA7f62a392a78472a3Ab83DD62467A3' },
  { key: 'more', name: 'MORE Token', type: 'ERC-20 proxy', address: '0xc0F1A40512114b25cc1F30b5DF0bb48691405555' },
  { key: 'batch', name: 'BatchMinter', type: 'Protocol proxy', address: '0xEaB771dB3883dC05DbEA1915F7e81910869bbc18' },
  { key: 'distributor', name: 'FeeDistributor', type: 'Protocol controller', address: '0x2f69ff61802d9738e562E438d1F6326389D95861' },
  { key: 'vault', name: 'MintVault', type: 'Pump fund', address: '0x492d111487f097759340dc119DE5887d58c38bB0' },
  { key: 'fuelBurner', name: 'FUEL Buy & Burn', type: 'Burn controller', address: '0x1f8e137117f78EF1EA84235F3E5423c46bF2D4A2' },
  { key: 'moreBurner', name: 'MORE Buy & Burn', type: 'Burn controller', address: '0x86f11A15E1793e7ce1F4264830d1973e80339A51' },
] as const

export const PAIRS = {
  fuel: '0xFF40c99525ffA6b6cf79ecbE370eF7C887D68F69',
  more: '0xd77dcda732a762ec8b04ee44a1c7370602759d2372037a5008135ab9f60305ef',
} as const

/**
 * Robinhood Chain WETH wrap token. Chain infrastructure, not a FUEL/MORE
 * protocol role. Listed by AxelCalloway/fuel-protocol-backup; checksum restored.
 * Not added to CONTRACTS and not used for protocol reads.
 */
export const ROBINHOOD_WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as const

export const fuelAbi = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function globalRank() view returns (uint256)',
  'function activeMinters() view returns (uint256)',
  'function totalTokenStaked() view returns (uint256)',
  'function activeStakes() view returns (uint256)',
  'function getCurrentAMP() view returns (uint256)',
  'function getCurrentEAAR() view returns (uint256)',
  'function getCurrentMaxTerm() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function userMints(address) view returns (address user, uint256 term, uint256 maturityTs, uint256 rank, uint256 amplifier, uint256 eaaRate)',
  'function userStakes(address) view returns (uint256 term, uint256 maturityTs, uint256 amount, uint256 apy)',
])

export const fuelBurnerAbi = parseAbi([
  'function totalTokenBurnt() view returns (uint256)',
  'function totalETHBurn() view returns (uint256)',
  'function ethUsedForBurns() view returns (uint256)',
  'function lastBurnedETHIntervalStartTimestamp() view returns (uint32)',
])

export const moreBurnerAbi = parseAbi([
  'function totalMoreBurnt() view returns (uint256)',
  'function totalETHBurn() view returns (uint256)',
  'function ethUsedForBurns() view returns (uint256)',
  'function lastBurnedETHIntervalStartTimestamp() view returns (uint32)',
])

export const vaultAbi = parseAbi([
  'function totalSwept() view returns (uint256)',
  'function genesisTs() view returns (uint256)',
  'function currentCycle() view returns (uint256)',
  'function currentCycleEnd() view returns (uint256)',
  'function stakedBalance() view returns (uint256)',
])

export const distributorAbi = parseAbi([
  'function totalDistributed() view returns (uint256)',
])

export const BLOCKSCOUT = 'https://robinhoodchain.blockscout.com'
export const DEXSCREENER = 'https://dexscreener.com/robinhood'
/** Uniswap Web App on Robinhood Chain — use our registry FUEL address only. */
export const UNISWAP_ROBINHOOD = 'https://app.uniswap.org/swap?chain=robinhood'
export const uniswapSellFuelUrl = () =>
  `${UNISWAP_ROBINHOOD}&inputCurrency=${CONTRACTS[0].address}&outputCurrency=NATIVE`
export const uniswapBuyFuelUrl = () =>
  `${UNISWAP_ROBINHOOD}&inputCurrency=NATIVE&outputCurrency=${CONTRACTS[0].address}`
