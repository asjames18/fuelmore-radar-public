import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'
import { CONTRACTS, PAIRS, ROBINHOOD_WETH, resolveRpcUrl, robinhood } from './contracts'
import { MORE_STAKING } from './more'

describe('RPC URL', () => {
  it('uses same-origin /rpc in the browser and direct RPC in Node', () => {
    expect(resolveRpcUrl('https://fuelmore-radar.example')).toBe('https://fuelmore-radar.example/rpc')
    expect(resolveRpcUrl('https://fuelmore-radar.example/')).toBe('https://fuelmore-radar.example/rpc')
    expect(resolveRpcUrl()).toBe('https://rpc.mainnet.chain.robinhood.com')
  })
})

describe('checksummed registry identities', () => {
  it('keeps configured addresses in EIP-55 form', () => {
    for (const contract of CONTRACTS) expect(contract.address).toBe(getAddress(contract.address))
    expect(MORE_STAKING).toBe(getAddress(MORE_STAKING))
    expect(ROBINHOOD_WETH).toBe(getAddress(ROBINHOOD_WETH))
    expect(PAIRS.fuel).toBe(getAddress(PAIRS.fuel))
    expect(robinhood.contracts.multicall3?.address).toBe(getAddress('0xcA11bde05977b3631167028862bE2a173976CA11'))
  })

  it('matches Axel/Willis byte identities after checksum restore, without relabeling MORE burner', () => {
    const axel = {
      fuel: '0xe60C1F5d9bA7f62a392a78472a3Ab83DD62467A3',
      batch: '0xEaB771dB3883dC05DbEA1915F7e81910869bbc18',
      vault: '0x492d111487f097759340dc119DE5887d58c38bB0',
      fuelBurner: '0x1f8e137117f78ef1ea84235f3e5423c46bf2d4a2',
      moreBurner: '0x86f11A15E1793e7ce1F4264830d1973e80339A51',
      distributor: '0x2f69ff61802d9738e562e438d1f6326389d95861',
      weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
    }
    expect(CONTRACTS[0].address).toBe(getAddress(axel.fuel))
    expect(CONTRACTS[2].address).toBe(getAddress(axel.batch))
    expect(CONTRACTS[4].address).toBe(getAddress(axel.vault))
    expect(CONTRACTS[5].address).toBe(getAddress(axel.fuelBurner))
    expect(CONTRACTS[6].address).toBe(getAddress(axel.moreBurner))
    expect(CONTRACTS[3].address).toBe(getAddress(axel.distributor))
    expect(ROBINHOOD_WETH).toBe(getAddress(axel.weth))
    expect(CONTRACTS[1].address).toBe(getAddress('0xc0F1A40512114b25cc1F30b5DF0bb48691405555'))
    expect(CONTRACTS[1].address.toLowerCase()).not.toBe(axel.moreBurner.toLowerCase())
  })
})
