import {
  packageBookAmendmentHash,
  packageBookCancellationHash,
  packageSettlementCommitmentHash,
  toHex,
  type PackageBookAmendment,
  type PackageBookCancellation,
  type PackageSettlementCommitment,
} from "@naryx/protocol-types";
import { verifyTypedData, type Hex } from "viem";

const EVM_PARTICIPANT = /^0x(?!0{40}$)[0-9a-f]{40}$/;
const EVM_SIGNATURE = /^0x[0-9a-f]{130}$/;

export function isEvmPackageBookParticipant(value: string): boolean {
  return EVM_PARTICIPANT.test(value);
}

export function packageSettlementAuthorizationTypedData(commitment: PackageSettlementCommitment) {
  return Object.freeze({
    domain: Object.freeze({ name: "Naryx Package Book Testnet", version: "1" }),
    types: Object.freeze({
      PackageSettlementAuthorization: Object.freeze([
        { name: "settlementCommitmentHash", type: "bytes32" },
        { name: "packageOrderId", type: "bytes32" },
        { name: "strategyOrderHash", type: "bytes32" },
        { name: "graphHash", type: "bytes32" },
        { name: "participant", type: "address" },
        { name: "environment", type: "string" },
        { name: "executionClassId", type: "string" },
        { name: "settlementAccount", type: "string" },
        { name: "quantity", type: "uint256" },
        { name: "validUntilUnit", type: "string" },
        { name: "validUntilValue", type: "uint256" },
      ]),
    }),
    primaryType: "PackageSettlementAuthorization" as const,
    message: Object.freeze({
      settlementCommitmentHash: `0x${toHex(packageSettlementCommitmentHash(commitment))}`,
      packageOrderId: `0x${toHex(commitment.packageOrderId)}`,
      strategyOrderHash: `0x${toHex(commitment.strategyOrderHash)}`,
      graphHash: `0x${toHex(commitment.graphHash)}`,
      participant: commitment.participantId,
      environment: commitment.environment,
      executionClassId: commitment.executionClassId,
      settlementAccount: commitment.settlementAccount,
      quantity: commitment.quantity.toString(),
      validUntilUnit: commitment.validUntilUnit,
      validUntilValue: commitment.validUntilValue.toString(),
    }),
  });
}

export function packageCancellationAuthorizationTypedData(cancellation: PackageBookCancellation) {
  return Object.freeze({
    domain: Object.freeze({ name: "Naryx Package Book Testnet", version: "1" }),
    types: Object.freeze({
      PackageCancellationAuthorization: Object.freeze([
        { name: "cancellationHash", type: "bytes32" },
        { name: "executionClassId", type: "string" },
        { name: "entryId", type: "bytes32" },
        { name: "participant", type: "address" },
      ]),
    }),
    primaryType: "PackageCancellationAuthorization" as const,
    message: Object.freeze({
      cancellationHash: `0x${toHex(packageBookCancellationHash(cancellation))}`,
      executionClassId: cancellation.executionClassId,
      entryId: `0x${toHex(cancellation.entryId)}`,
      participant: cancellation.participantId,
    }),
  });
}

export function packageAmendmentAuthorizationTypedData(amendment: PackageBookAmendment) {
  return Object.freeze({
    domain: Object.freeze({ name: "Naryx Package Book Testnet", version: "1" }),
    types: Object.freeze({
      PackageAmendmentAuthorization: Object.freeze([
        { name: "amendmentHash", type: "bytes32" },
        { name: "executionClassId", type: "string" },
        { name: "entryId", type: "bytes32" },
        { name: "participant", type: "address" },
        { name: "expectedQuantity", type: "uint256" },
        { name: "expectedPriceTicks", type: "int256" },
        { name: "changesQuantity", type: "bool" },
        { name: "quantity", type: "uint256" },
        { name: "changesPrice", type: "bool" },
        { name: "priceTicks", type: "int256" },
      ]),
    }),
    primaryType: "PackageAmendmentAuthorization" as const,
    message: Object.freeze({
      amendmentHash: `0x${toHex(packageBookAmendmentHash(amendment))}`,
      executionClassId: amendment.executionClassId,
      entryId: `0x${toHex(amendment.entryId)}`,
      participant: amendment.participantId,
      expectedQuantity: amendment.expectedQuantity,
      expectedPriceTicks: amendment.expectedPriceTicks,
      changesQuantity: amendment.quantity !== undefined,
      quantity: amendment.quantity ?? 0n,
      changesPrice: amendment.priceTicks !== undefined,
      priceTicks: amendment.priceTicks ?? 0n,
    }),
  });
}

export async function verifyEvmPackageSettlementAuthorization(
  commitment: PackageSettlementCommitment,
  signatureInput: unknown,
): Promise<boolean> {
  if (!isEvmPackageBookParticipant(commitment.participantId) || typeof signatureInput !== "string") return false;
  const signature = signatureInput.toLowerCase();
  if (!EVM_SIGNATURE.test(signature)) return false;
  const typedData = packageSettlementAuthorizationTypedData(commitment);
  try {
    return await verifyTypedData({
      address: commitment.participantId as Hex,
      domain: typedData.domain,
      types: { PackageSettlementAuthorization: [...typedData.types.PackageSettlementAuthorization] },
      primaryType: typedData.primaryType,
      message: {
        ...typedData.message,
        settlementCommitmentHash: typedData.message.settlementCommitmentHash as Hex,
        packageOrderId: typedData.message.packageOrderId as Hex,
        strategyOrderHash: typedData.message.strategyOrderHash as Hex,
        graphHash: typedData.message.graphHash as Hex,
        participant: commitment.participantId as Hex,
      },
      signature: signature as Hex,
    });
  } catch {
    return false;
  }
}

export async function verifyEvmPackageCancellationAuthorization(
  cancellation: PackageBookCancellation,
  signatureInput: unknown,
): Promise<boolean> {
  if (!isEvmPackageBookParticipant(cancellation.participantId) || typeof signatureInput !== "string") return false;
  const signature = signatureInput.toLowerCase();
  if (!EVM_SIGNATURE.test(signature)) return false;
  const typedData = packageCancellationAuthorizationTypedData(cancellation);
  try {
    return await verifyTypedData({
      address: cancellation.participantId as Hex,
      domain: typedData.domain,
      types: { PackageCancellationAuthorization: [...typedData.types.PackageCancellationAuthorization] },
      primaryType: typedData.primaryType,
      message: {
        ...typedData.message,
        cancellationHash: typedData.message.cancellationHash as Hex,
        entryId: typedData.message.entryId as Hex,
        participant: cancellation.participantId as Hex,
      },
      signature: signature as Hex,
    });
  } catch {
    return false;
  }
}

export async function verifyEvmPackageAmendmentAuthorization(
  amendment: PackageBookAmendment,
  signatureInput: unknown,
): Promise<boolean> {
  if (!isEvmPackageBookParticipant(amendment.participantId) || typeof signatureInput !== "string") return false;
  const signature = signatureInput.toLowerCase();
  if (!EVM_SIGNATURE.test(signature)) return false;
  const typedData = packageAmendmentAuthorizationTypedData(amendment);
  try {
    return await verifyTypedData({
      address: amendment.participantId as Hex,
      domain: typedData.domain,
      types: { PackageAmendmentAuthorization: [...typedData.types.PackageAmendmentAuthorization] },
      primaryType: typedData.primaryType,
      message: {
        ...typedData.message,
        amendmentHash: typedData.message.amendmentHash as Hex,
        entryId: typedData.message.entryId as Hex,
        participant: amendment.participantId as Hex,
      },
      signature: signature as Hex,
    });
  } catch {
    return false;
  }
}
