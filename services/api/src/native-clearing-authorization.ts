import bs58 from 'bs58';
import { isEvmStrategyActor, type CommitmentHash } from '@naryx/protocol-types';
import { verifyMessage, type Hex } from 'viem';
import { verifyEd25519 } from './ed25519.js';

const EVM_SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

export type NativeClearingControlSignature =
  | Readonly<{ scheme: 'ED25519'; signature: string }>
  | Readonly<{ scheme: 'EIP191_SECP256K1'; signature: string }>;

export async function verifyNativeClearingControlSignature(
  signerId: string,
  digest: CommitmentHash,
  authorization: NativeClearingControlSignature,
): Promise<boolean> {
  if (authorization.scheme === 'ED25519') {
    try {
      const key = bs58.decode(signerId);
      const signature = bs58.decode(authorization.signature);
      return key.length === 32
        && signature.length === 64
        && bs58.encode(key) === signerId
        && bs58.encode(signature) === authorization.signature
        && verifyEd25519(key, digest, signature);
    } catch {
      return false;
    }
  }
  if (!isEvmStrategyActor(signerId) || !EVM_SIGNATURE.test(authorization.signature)) return false;
  try {
    return await verifyMessage({
      address: signerId as Hex,
      message: { raw: digest },
      signature: authorization.signature as Hex,
    });
  } catch {
    return false;
  }
}
