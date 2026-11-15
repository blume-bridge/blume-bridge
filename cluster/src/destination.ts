import { isValidClassicAddress, isValidXAddress, xAddressToClassicAddress } from 'ripple-address-codec'

/** Where a release is paid: an XRP Ledger account and, for an exchange or hosted wallet, the destination tag that says whose deposit it is. */
export interface Destination {
  address: string
  tag?: number
}

/**
 * The destination a burn names, or null when no release could ever pay it. The burn carries a string, and the minter
 * lets two forms through: a classic address, and an X-address, which is an account and a destination tag in one string.
 * An exchange deposit address is only usable with its tag, so the X-address has to be decoded here and the tag put on the
 * release.
 *
 * An X-address made for the other network (a test-network `T…` address on the main network, or the reverse) is refused
 * when the network is known: it is a mistake, and the funds would go to an account on a ledger the sender did not mean.
 */
export function parseDestination(raw: string, network?: 'mainnet' | 'test'): Destination | null {
  if (isValidClassicAddress(raw)) return { address: raw }
  if (!isValidXAddress(raw)) return null
  let decoded: { classicAddress: string; tag: number | false; test: boolean }
  try {
    decoded = xAddressToClassicAddress(raw)
  } catch {
    return null
  }
  if (network !== undefined && decoded.test !== (network === 'test')) return null
  return decoded.tag === false ? { address: decoded.classicAddress } : { address: decoded.classicAddress, tag: decoded.tag }
}
