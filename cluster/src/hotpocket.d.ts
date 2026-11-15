declare module 'hotpocket-nodejs-contract' {
  export interface HpUser {
    publicKey: string
    inputs: [number, number][]
    send(msg: unknown): Promise<void>
  }
  export interface HpUnlNode {
    publicKey: string
    activeOn: number
  }
  export interface HpContext {
    contractId: string
    publicKey: string
    privateKey: string
    readonly: boolean
    timestamp: number
    lclSeqNo: number
    lclHash: string
    users: { list(): HpUser[]; find(publicKey: string): HpUser | undefined; count(): number; read(input: [number, number]): Promise<Buffer> }
    unl: { list(): HpUnlNode[]; count(): number; onMessage(cb: (node: HpUnlNode, msg: Buffer) => void): void; send(msg: string | Buffer): Promise<void> }
    getConfig(): Promise<any>
    updateConfig(config: any): Promise<void>
    updatePeers(toAdd: string[], toRemove?: string[]): Promise<void>
  }
  export class Contract {
    init(fn: (ctx: HpContext) => Promise<void> | void, clientProtocol?: string, forceTerminate?: boolean): Promise<boolean>
  }
  export const clientProtocols: { json: string; bson: string }
  const hotpocket: { Contract: typeof Contract; clientProtocols: typeof clientProtocols; POST_EXEC_SCRIPT_NAME: string }
  export default hotpocket
}

declare module 'hotpocket-js-client' {
  const client: any
  export default client
}
