import bs58 from "bs58";
import {
  isEvmStrategyActor,
  strategyCommandAuthorizationTypedData,
  strategyCommandHash,
  type StrategyCommandInput,
} from "@naryx/protocol-types";
import { verifyTypedData, type Hex } from "viem";
import { verifyEd25519 } from "./ed25519.js";

const EVM_SIGNATURE = /^0x[0-9a-f]{130}$/;

export type StrategyCommandAuthorization =
  | { readonly scheme: "ED25519"; readonly signature: string }
  | { readonly scheme: "EIP712_SECP256K1"; readonly signature: string };

export async function verifyStrategyCommandAuthorization(
  command: StrategyCommandInput,
  signerId: string,
  authorization: StrategyCommandAuthorization,
): Promise<Uint8Array | undefined> {
  if (authorization.scheme === "ED25519") {
    try {
      const key = bs58.decode(signerId);
      const signature = bs58.decode(authorization.signature);
      if (key.length !== 32 || signature.length !== 64 || bs58.encode(key) !== signerId
        || bs58.encode(signature) !== authorization.signature) return undefined;
      return verifyEd25519(key, strategyCommandHash(command), signature)
        ? Uint8Array.from(signature)
        : undefined;
    } catch {
      return undefined;
    }
  }
  if (!isEvmStrategyActor(signerId) || !EVM_SIGNATURE.test(authorization.signature)) return undefined;
  const typedData = strategyCommandAuthorizationTypedData(command, signerId);
  try {
    const valid = await verifyTypedData({
      address: signerId as Hex,
      domain: typedData.domain,
      types: { StrategyCommandAuthorization: [...typedData.types.StrategyCommandAuthorization] },
      primaryType: typedData.primaryType,
      message: {
        ...typedData.message,
        commandHash: typedData.message.commandHash as Hex,
        signer: signerId as Hex,
      },
      signature: authorization.signature as Hex,
    });
    return valid ? Uint8Array.from(Buffer.from(authorization.signature.slice(2), "hex")) : undefined;
  } catch {
    return undefined;
  }
}

export function storedStrategyCommandAuthorization(
  signerId: string,
  signature: Uint8Array,
): StrategyCommandAuthorization {
  if (isEvmStrategyActor(signerId)) {
    if (signature.length !== 65) throw new TypeError("stored EVM strategy signature must be 65 bytes");
    return Object.freeze({ scheme: "EIP712_SECP256K1", signature: `0x${Buffer.from(signature).toString("hex")}` });
  }
  if (signature.length !== 64) throw new TypeError("stored Ed25519 strategy signature must be 64 bytes");
  return Object.freeze({ scheme: "ED25519", signature: bs58.encode(signature) });
}
