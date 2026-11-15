/**
 * Intermediate CA certificates that some public XRPL RPC servers do not send
 * in their chain. Node verifies against its bundled roots only, so a missing
 * intermediate fails with UNABLE_TO_GET_ISSUER_CERT_LOCALLY. Public
 * certificates, safe to ship. Filled per endpoint as they are found.
 */
export const EXTRA_CA_CERTS: string[] = []
