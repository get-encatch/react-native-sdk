/**
 * The gateway's secure-identify check lives in the mock API, so the SDK tests and
 * the mock server use one implementation. See examples/mock-api/src/signature.ts.
 */
export {
  checkIdentifySignature as gatewayCheckIdentify,
  hmacHex,
  type SignatureKey as GatewayKey,
  type SignatureResult as GatewayResult,
} from '../examples/mock-api/src/signature';
